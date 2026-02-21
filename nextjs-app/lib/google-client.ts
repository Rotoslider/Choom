/**
 * Google REST API Client
 * Lightweight client for Calendar and Tasks APIs using OAuth2 token from signal-bridge.
 * No Google SDK dependency — uses fetch() against REST endpoints.
 */

import { readFile, writeFile } from 'fs/promises';
import path from 'path';

const TOKEN_PATH = path.join(process.cwd(), 'services/signal-bridge/google_auth/token.json');

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
const TASKS_BASE = 'https://www.googleapis.com/tasks/v1';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const DOCS_BASE = 'https://docs.googleapis.com/v1/documents';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1';
const PEOPLE_BASE = 'https://people.googleapis.com/v1';
const YOUTUBE_BASE = 'https://www.googleapis.com/youtube/v3';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

interface GoogleToken {
  token: string;
  refresh_token: string;
  token_uri: string;
  client_id: string;
  client_secret: string;
  scopes: string[];
  expiry: string;
}

interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: string;
  end: string;
  location?: string;
}

interface TaskList {
  id: string;
  title: string;
}

interface TaskItem {
  id: string;
  title: string;
  notes?: string;
  due?: string;
  status?: string;
}

class GoogleClient {
  private token: GoogleToken | null = null;
  private accessToken: string = '';
  private expiresAt: number = 0;

  private async loadToken(): Promise<GoogleToken> {
    const data = await readFile(TOKEN_PATH, 'utf-8');
    this.token = JSON.parse(data);
    this.accessToken = this.token!.token;
    this.expiresAt = new Date(this.token!.expiry).getTime();
    return this.token!;
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.token) await this.loadToken();

    const body = new URLSearchParams({
      client_id: this.token!.client_id,
      client_secret: this.token!.client_secret,
      refresh_token: this.token!.refresh_token,
      grant_type: 'refresh_token',
    });

    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Token refresh failed (${res.status}): ${errText}`);
    }

    const data = await res.json();
    this.accessToken = data.access_token;
    // Google returns expires_in in seconds
    const expiresIn = data.expires_in || 3600;
    const expiryDate = new Date(Date.now() + expiresIn * 1000);
    this.expiresAt = expiryDate.getTime();

    // Write refreshed token back to file so Python bridge stays in sync
    this.token!.token = this.accessToken;
    this.token!.expiry = expiryDate.toISOString();
    await writeFile(TOKEN_PATH, JSON.stringify(this.token, null, 2));
  }

  private async getAccessToken(): Promise<string> {
    if (!this.token) await this.loadToken();

    // Refresh if expired or expiring within 60s
    if (Date.now() > this.expiresAt - 60_000) {
      await this.refreshAccessToken();
    }

    return this.accessToken;
  }

  /**
   * Normalize sheet values: LLMs sometimes send 2D arrays as a JSON string
   * instead of an actual array. Parse if needed so the Sheets API receives
   * a proper ListValue, not a string.
   */

  private normalizeSheetValues(values: any): string[][] {
    if (typeof values === 'string') {
      try {
        return JSON.parse(values);
      } catch {
        // If it's not valid JSON, wrap as single cell
        return [[values]];
      }
    }
    return values;
  }

  private async apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
    const token = await this.getAccessToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    let res = await fetch(url, { ...options, headers });

    // 401 retry: force-refresh token and retry once
    if (res.status === 401) {
      console.log('   🔑 Google API 401 — refreshing token and retrying');
      await this.refreshAccessToken();
      const retryHeaders = {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      };
      res = await fetch(url, { ...options, headers: retryHeaders });
    }

    return res;
  }

  // =========================================================================
  // Calendar
  // =========================================================================

  async getCalendarEvents(daysAhead: number = 7, query?: string, daysBack?: number): Promise<CalendarEvent[]> {
    const now = new Date();
    const timeMin = daysBack
      ? new Date(now.getTime() - daysBack * 86400_000).toISOString()
      : now.toISOString();
    const timeMax = new Date(now.getTime() + daysAhead * 86400_000).toISOString();

    const params = new URLSearchParams({
      calendarId: 'primary',
      timeMin,
      timeMax,
      maxResults: '50',
      singleEvents: 'true',
      orderBy: 'startTime',
    });
    if (query) params.set('q', query);

    const res = await this.apiFetch(`${CALENDAR_BASE}/calendars/primary/events?${params}`);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Calendar API error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    const events = data.items || [];

    return events.map((e: Record<string, unknown>) => ({
      id: e.id as string,
      summary: (e.summary as string) || 'No title',
      description: (e.description as string) || '',
      start: ((e.start as Record<string, string>)?.dateTime || (e.start as Record<string, string>)?.date) || '',
      end: ((e.end as Record<string, string>)?.dateTime || (e.end as Record<string, string>)?.date) || '',
      location: (e.location as string) || '',
    }));
  }

  // =========================================================================
  // Tasks
  // =========================================================================

  async getTaskLists(): Promise<TaskList[]> {
    const res = await this.apiFetch(`${TASKS_BASE}/users/@me/lists`);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Tasks API error (${res.status}): ${errText}`);
    }
    const data = await res.json();
    return (data.items || []).map((tl: Record<string, unknown>) => ({
      id: tl.id as string,
      title: tl.title as string,
    }));
  }

  private async findListByName(name: string): Promise<TaskList | null> {
    const lists = await this.getTaskLists();
    const lower = name.toLowerCase();

    // 1. Exact match (case-insensitive)
    const exact = lists.find(l => l.title.toLowerCase() === lower);
    if (exact) return exact;

    // 2. Normalize: strip apostrophes/punctuation, compare
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    const normalizedInput = normalize(name);
    const normalized = lists.find(l => normalize(l.title) === normalizedInput);
    if (normalized) return normalized;

    // 3. Singular/plural: strip trailing 's' or 'es' to match "Boxes" → "Box's" etc.
    const deplural = (s: string) => s.replace(/e?s$/i, '');
    const depluralized = lists.find(l => deplural(normalize(l.title)) === deplural(normalizedInput));
    if (depluralized) return depluralized;

    // 4. Starts-with match (input is prefix of list name or vice versa)
    const startsWith = lists.find(l =>
      l.title.toLowerCase().startsWith(lower) || lower.startsWith(l.title.toLowerCase())
    );
    if (startsWith) return startsWith;

    // 5. Contains match
    const contains = lists.find(l =>
      l.title.toLowerCase().includes(lower) || lower.includes(l.title.toLowerCase())
    );
    if (contains) return contains;

    return null;
  }

  async getTasksByListName(listName: string): Promise<TaskItem[]> {
    const list = await this.findListByName(listName);
    if (!list) throw new Error(`Task list "${listName}" not found. Available lists: ${(await this.getTaskLists()).map(l => l.title).join(', ')}`);

    const params = new URLSearchParams({
      showCompleted: 'false',
      showHidden: 'false',
    });

    const res = await this.apiFetch(`${TASKS_BASE}/lists/${list.id}/tasks?${params}`);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Tasks API error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    return (data.items || []).map((t: Record<string, unknown>) => ({
      id: t.id as string,
      title: t.title as string,
      notes: (t.notes as string) || '',
      due: (t.due as string) || undefined,
      status: t.status as string,
    }));
  }

  async addTaskToListName(listName: string, title: string, notes?: string): Promise<TaskItem> {
    const list = await this.findListByName(listName);
    if (!list) throw new Error(`Task list "${listName}" not found. Available lists: ${(await this.getTaskLists()).map(l => l.title).join(', ')}`);

    const body: Record<string, string> = { title };
    if (notes) body.notes = notes;

    const res = await this.apiFetch(`${TASKS_BASE}/lists/${list.id}/tasks`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Tasks API error (${res.status}): ${errText}`);
    }

    const task = await res.json();
    return {
      id: task.id,
      title: task.title,
      notes: task.notes || '',
      status: task.status,
    };
  }

  async removeTaskFromListName(listName: string, itemTitle: string): Promise<boolean> {
    const list = await this.findListByName(listName);
    if (!list) throw new Error(`Task list "${listName}" not found. Available lists: ${(await this.getTaskLists()).map(l => l.title).join(', ')}`);

    // Get all tasks, find by title (case-insensitive)
    const tasks = await this.getTasksByListName(listName);
    const task = tasks.find(t => t.title.toLowerCase() === itemTitle.toLowerCase());
    if (!task) throw new Error(`Task "${itemTitle}" not found in "${listName}". Current items: ${tasks.map(t => t.title).join(', ')}`);

    const res = await this.apiFetch(`${TASKS_BASE}/lists/${list.id}/tasks/${task.id}`, {
      method: 'DELETE',
    });

    if (!res.ok && res.status !== 204) {
      const errText = await res.text();
      throw new Error(`Tasks API error (${res.status}): ${errText}`);
    }

    return true;
  }

  // =========================================================================
  // Calendar Write
  // =========================================================================

  async createCalendarEvent(summary: string, startTime: string, endTime: string, options?: {
    description?: string; location?: string; allDay?: boolean;
  }): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = { summary };
    if (options?.description) body.description = options.description;
    if (options?.location) body.location = options.location;

    if (options?.allDay) {
      body.start = { date: startTime.slice(0, 10) };
      body.end = { date: endTime.slice(0, 10) };
    } else {
      body.start = { dateTime: startTime, timeZone: 'America/Denver' };
      body.end = { dateTime: endTime, timeZone: 'America/Denver' };
    }

    const res = await this.apiFetch(`${CALENDAR_BASE}/calendars/primary/events`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Calendar API error (${res.status}): ${await res.text()}`);
    const event = await res.json();
    return {
      id: event.id,
      summary: event.summary || '',
      start: event.start?.dateTime || event.start?.date || '',
      end: event.end?.dateTime || event.end?.date || '',
      htmlLink: event.htmlLink || '',
    };
  }

  async updateCalendarEvent(eventId: string, updates: {
    summary?: string; startTime?: string; endTime?: string; description?: string; location?: string;
  }): Promise<Record<string, unknown>> {
    // Get existing event
    const getRes = await this.apiFetch(`${CALENDAR_BASE}/calendars/primary/events/${eventId}`);
    if (!getRes.ok) throw new Error(`Calendar API error (${getRes.status}): ${await getRes.text()}`);
    const event = await getRes.json();

    if (updates.summary !== undefined) event.summary = updates.summary;
    if (updates.description !== undefined) event.description = updates.description;
    if (updates.location !== undefined) event.location = updates.location;
    if (updates.startTime) event.start = { dateTime: updates.startTime, timeZone: 'America/Denver' };
    if (updates.endTime) event.end = { dateTime: updates.endTime, timeZone: 'America/Denver' };

    const res = await this.apiFetch(`${CALENDAR_BASE}/calendars/primary/events/${eventId}`, {
      method: 'PUT',
      body: JSON.stringify(event),
    });
    if (!res.ok) throw new Error(`Calendar API error (${res.status}): ${await res.text()}`);
    const updated = await res.json();
    return {
      id: updated.id,
      summary: updated.summary || '',
      start: updated.start?.dateTime || updated.start?.date || '',
      end: updated.end?.dateTime || updated.end?.date || '',
    };
  }

  async deleteCalendarEvent(eventId: string): Promise<boolean> {
    const res = await this.apiFetch(`${CALENDAR_BASE}/calendars/primary/events/${eventId}`, {
      method: 'DELETE',
    });
    if (!res.ok && res.status !== 204) {
      throw new Error(`Calendar API error (${res.status}): ${await res.text()}`);
    }
    return true;
  }

  // =========================================================================
  // Sheets
  // =========================================================================

  async listSpreadsheets(maxResults: number = 20): Promise<Array<Record<string, string>>> {
    const params = new URLSearchParams({
      q: "mimeType='application/vnd.google-apps.spreadsheet'",
      pageSize: String(maxResults),
      fields: 'files(id,name,modifiedTime,webViewLink)',
      orderBy: 'modifiedTime desc',
    });
    const res = await this.apiFetch(`${DRIVE_BASE}/files?${params}`);
    if (!res.ok) throw new Error(`Drive API error (${res.status}): ${await res.text()}`);
    const data = await res.json();
    return (data.files || []).map((f: Record<string, string>) => ({
      id: f.id, name: f.name, modifiedTime: f.modifiedTime || '', url: f.webViewLink || '',
    }));
  }

  async createSpreadsheet(title: string, sheetNames?: string[], initialData?: string[][]): Promise<{ id: string; title: string; url: string; sheetNames: string[] }> {
    const body: Record<string, unknown> = { properties: { title } };
    if (sheetNames) {
      body.sheets = sheetNames.map(name => ({ properties: { title: name } }));
    }

    const res = await this.apiFetch(SHEETS_BASE, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Sheets API error (${res.status}): ${await res.text()}`);
    const ss = await res.json();
    const ssId = ss.spreadsheetId;

    // Write initial data if provided
    if (initialData && initialData.length > 0) {
      const sheetTitle = sheetNames?.[0] || 'Sheet1';
      const normalized = this.normalizeSheetValues(initialData);
      await this.apiFetch(
        `${SHEETS_BASE}/${ssId}/values/${encodeURIComponent(sheetTitle + '!A1')}?valueInputOption=USER_ENTERED`,
        { method: 'PUT', body: JSON.stringify({ values: normalized }) }
      );
    }

    // Return actual sheet/tab names so the LLM knows what to reference
    const actualSheetNames = sheetNames || ['Sheet1'];
    return { id: ssId, title, url: `https://docs.google.com/spreadsheets/d/${ssId}/edit`, sheetNames: actualSheetNames };
  }

  /** Fetch the actual tab names for a spreadsheet (used in error recovery) */
  async getSheetNames(spreadsheetId: string): Promise<string[]> {
    try {
      const res = await this.apiFetch(`${SHEETS_BASE}/${spreadsheetId}?fields=sheets.properties.title`);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.sheets || []).map((s: { properties?: { title?: string } }) => s.properties?.title || '').filter(Boolean);
    } catch { return []; }
  }

  async readSheet(spreadsheetId: string, range: string): Promise<{ values: string[][]; range: string }> {
    const res = await this.apiFetch(`${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}`);
    if (!res.ok) {
      const errText = await res.text();
      // On range parse error, include actual tab names to help the LLM self-correct
      if (errText.includes('Unable to parse range')) {
        const tabs = await this.getSheetNames(spreadsheetId);
        throw new Error(`Sheets API error (${res.status}): Unable to parse range "${range}". Available tabs: [${tabs.join(', ')}]. Use one of these tab names instead of "Sheet1".`);
      }
      throw new Error(`Sheets API error (${res.status}): ${errText}`);
    }
    const data = await res.json();
    return { values: data.values || [], range: data.range || range };
  }


  async writeSheet(spreadsheetId: string, range: string, values: any): Promise<Record<string, unknown>> {
    const normalized = this.normalizeSheetValues(values);
    const res = await this.apiFetch(
      `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
      { method: 'PUT', body: JSON.stringify({ values: normalized }) }
    );
    if (!res.ok) {
      const errText = await res.text();
      if (errText.includes('Unable to parse range')) {
        const tabs = await this.getSheetNames(spreadsheetId);
        throw new Error(`Sheets API error (${res.status}): Unable to parse range "${range}". Available tabs: [${tabs.join(', ')}]. Use one of these tab names instead of "Sheet1".`);
      }
      throw new Error(`Sheets API error (${res.status}): ${errText}`);
    }
    const data = await res.json();
    return {
      updatedRange: data.updatedRange || '',
      updatedRows: data.updatedRows || 0,
      updatedColumns: data.updatedColumns || 0,
      updatedCells: data.updatedCells || 0,
    };
  }


  async appendToSheet(spreadsheetId: string, range: string, values: any): Promise<Record<string, unknown>> {
    const normalized = this.normalizeSheetValues(values);
    const res = await this.apiFetch(
      `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      { method: 'POST', body: JSON.stringify({ values: normalized }) }
    );
    if (!res.ok) {
      const errText = await res.text();
      if (errText.includes('Unable to parse range')) {
        const tabs = await this.getSheetNames(spreadsheetId);
        throw new Error(`Sheets API error (${res.status}): Unable to parse range "${range}". Available tabs: [${tabs.join(', ')}]. Use one of these tab names instead of "Sheet1".`);
      }
      throw new Error(`Sheets API error (${res.status}): ${errText}`);
    }
    const data = await res.json();
    const updates = data.updates || {};
    return {
      updatedRange: updates.updatedRange || '',
      updatedRows: updates.updatedRows || 0,
      updatedCells: updates.updatedCells || 0,
    };
  }

  // =========================================================================
  // Docs
  // =========================================================================

  async listDocuments(maxResults: number = 20): Promise<Array<Record<string, string>>> {
    const params = new URLSearchParams({
      q: "mimeType='application/vnd.google-apps.document'",
      pageSize: String(maxResults),
      fields: 'files(id,name,modifiedTime,webViewLink)',
      orderBy: 'modifiedTime desc',
    });
    const res = await this.apiFetch(`${DRIVE_BASE}/files?${params}`);
    if (!res.ok) throw new Error(`Drive API error (${res.status}): ${await res.text()}`);
    const data = await res.json();
    return (data.files || []).map((f: Record<string, string>) => ({
      id: f.id, name: f.name, modifiedTime: f.modifiedTime || '', url: f.webViewLink || '',
    }));
  }

  async createDocument(title: string, content?: string): Promise<Record<string, string>> {
    const res = await this.apiFetch(DOCS_BASE, {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
    if (!res.ok) throw new Error(`Docs API error (${res.status}): ${await res.text()}`);
    const doc = await res.json();
    const docId = doc.documentId;

    if (content) {
      await this.apiFetch(`${DOCS_BASE}/${docId}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          requests: [{ insertText: { location: { index: 1 }, text: content } }],
        }),
      });
    }

    return { id: docId, title, url: `https://docs.google.com/document/d/${docId}/edit` };
  }

  async readDocument(documentId: string): Promise<{ title: string; content: string; id: string }> {
    const res = await this.apiFetch(`${DOCS_BASE}/${documentId}`);
    if (!res.ok) throw new Error(`Docs API error (${res.status}): ${await res.text()}`);
    const doc = await res.json();

    let text = '';
    for (const element of doc.body?.content || []) {
      if (element.paragraph) {
        for (const pe of element.paragraph.elements || []) {
          if (pe.textRun) text += pe.textRun.content;
        }
      }
    }
    return { title: doc.title || '', content: text, id: documentId };
  }

  async appendToDocument(documentId: string, text: string): Promise<Record<string, unknown>> {
    // Get current doc to find end index
    const getRes = await this.apiFetch(`${DOCS_BASE}/${documentId}`);
    if (!getRes.ok) throw new Error(`Docs API error (${getRes.status}): ${await getRes.text()}`);
    const doc = await getRes.json();
    const bodyContent = doc.body?.content || [];
    const endIndex = bodyContent[bodyContent.length - 1]?.endIndex - 1 || 1;

    const res = await this.apiFetch(`${DOCS_BASE}/${documentId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{ insertText: { location: { index: endIndex }, text } }],
      }),
    });
    if (!res.ok) throw new Error(`Docs API error (${res.status}): ${await res.text()}`);

    return { id: documentId, title: doc.title || '', appendedLength: text.length };
  }

  // =========================================================================
  // Drive
  // =========================================================================

  async listDriveFiles(folderId?: string, maxResults: number = 20): Promise<Array<Record<string, string>>> {
    const params = new URLSearchParams({
      pageSize: String(maxResults),
      fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink)',
      orderBy: 'modifiedTime desc',
    });
    if (folderId) params.set('q', `'${folderId}' in parents`);

    const res = await this.apiFetch(`${DRIVE_BASE}/files?${params}`);
    if (!res.ok) throw new Error(`Drive API error (${res.status}): ${await res.text()}`);
    const data = await res.json();
    return (data.files || []).map((f: Record<string, string>) => ({
      id: f.id, name: f.name, mimeType: f.mimeType || '', modifiedTime: f.modifiedTime || '',
      size: f.size || '', url: f.webViewLink || '',
    }));
  }

  async searchDrive(query: string, maxResults: number = 20): Promise<Array<Record<string, string>>> {
    const params = new URLSearchParams({
      q: `name contains '${query.replace(/'/g, "\\'")}'`,
      pageSize: String(maxResults),
      fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink)',
      orderBy: 'modifiedTime desc',
    });
    const res = await this.apiFetch(`${DRIVE_BASE}/files?${params}`);
    if (!res.ok) throw new Error(`Drive API error (${res.status}): ${await res.text()}`);
    const data = await res.json();
    return (data.files || []).map((f: Record<string, string>) => ({
      id: f.id, name: f.name, mimeType: f.mimeType || '', modifiedTime: f.modifiedTime || '',
      size: f.size || '', url: f.webViewLink || '',
    }));
  }

  async createDriveFolder(name: string, parentId?: string): Promise<Record<string, string>> {
    const body: Record<string, unknown> = {
      name,
      mimeType: 'application/vnd.google-apps.folder',
    };
    if (parentId) body.parents = [parentId];

    const res = await this.apiFetch(`${DRIVE_BASE}/files?fields=id,name,webViewLink`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Drive API error (${res.status}): ${await res.text()}`);
    const folder = await res.json();
    return { id: folder.id, name: folder.name, url: `https://drive.google.com/drive/folders/${folder.id}` };
  }

  async uploadToDrive(filePath: string, folderId?: string, driveFilename?: string): Promise<Record<string, string>> {
    const { readFile: readFs } = await import('fs/promises');
    const pathMod = await import('path');

    const fileContent = await readFs(filePath);
    const filename = driveFilename || pathMod.basename(filePath);

    // Determine MIME type from extension
    const ext = pathMod.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
      '.json': 'application/json', '.pdf': 'application/pdf',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp',
      '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
      '.py': 'text/x-python', '.ts': 'text/typescript',
      '.db': 'application/x-sqlite3',
    };
    const mimeType = mimeMap[ext] || 'application/octet-stream';

    // Multipart upload: metadata + content in one request
    const metadata: Record<string, unknown> = { name: filename };
    if (folderId) metadata.parents = [folderId];

    const boundary = '===multipart_boundary_' + Date.now() + '===';
    const metadataPart = JSON.stringify(metadata);

    // Build multipart body
    const parts: Buffer[] = [];
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataPart}\r\n`
    ));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`));
    parts.push(fileContent);
    parts.push(Buffer.from(`\r\n--${boundary}--`));

    const body = Buffer.concat(parts);

    const token = await this.getAccessToken();
    const res = await fetch(`${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,webViewLink,size`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
    });

    if (!res.ok) throw new Error(`Drive upload error (${res.status}): ${await res.text()}`);
    const file = await res.json();
    return { id: file.id, name: file.name, url: `https://drive.google.com/file/d/${file.id}/view`, size: file.size || '' };
  }

  async downloadFromDrive(fileId: string, outputPath: string): Promise<string> {
    const { writeFile: writeFs } = await import('fs/promises');
    const { mkdir } = await import('fs/promises');
    const pathMod = await import('path');

    // Get file metadata
    const metaRes = await this.apiFetch(`${DRIVE_BASE}/files/${fileId}?fields=mimeType,name`);
    if (!metaRes.ok) throw new Error(`Drive API error (${metaRes.status}): ${await metaRes.text()}`);
    const meta = await metaRes.json();
    const mime = meta.mimeType || '';

    // Ensure output directory exists
    await mkdir(pathMod.dirname(outputPath), { recursive: true });

    let contentRes: Response;
    if (mime === 'application/vnd.google-apps.document') {
      contentRes = await this.apiFetch(`${DRIVE_BASE}/files/${fileId}/export?mimeType=text/plain`);
    } else if (mime === 'application/vnd.google-apps.spreadsheet') {
      contentRes = await this.apiFetch(`${DRIVE_BASE}/files/${fileId}/export?mimeType=text/csv`);
    } else {
      contentRes = await this.apiFetch(`${DRIVE_BASE}/files/${fileId}?alt=media`);
    }

    if (!contentRes.ok) throw new Error(`Drive download error (${contentRes.status}): ${await contentRes.text()}`);
    const buffer = Buffer.from(await contentRes.arrayBuffer());
    await writeFs(outputPath, buffer);

    return outputPath;
  }

  // =========================================================================
  // Gmail
  // =========================================================================

  async listEmails(maxResults: number = 20, label: string = 'INBOX', query?: string): Promise<Array<{ id: string; threadId: string; from: string; to: string; subject: string; date: string; snippet: string }>> {
    const params = new URLSearchParams({
      maxResults: String(maxResults),
      labelIds: label,
    });
    if (query) params.set('q', query);

    const res = await this.apiFetch(`${GMAIL_BASE}/users/me/messages?${params}`);
    if (!res.ok) throw new Error(`Gmail API error (${res.status}): ${await res.text()}`);
    const data = await res.json();
    const messageIds = (data.messages || []) as Array<{ id: string; threadId: string }>;

    if (messageIds.length === 0) return [];

    // Batch fetch metadata for each message
    const emails = await Promise.all(
      messageIds.slice(0, maxResults).map(async (msg) => {
        const metaRes = await this.apiFetch(
          `${GMAIL_BASE}/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`
        );
        if (!metaRes.ok) return null;
        const meta = await metaRes.json();
        const headers = (meta.payload?.headers || []) as Array<{ name: string; value: string }>;
        const getHeader = (name: string) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

        return {
          id: meta.id,
          threadId: meta.threadId,
          from: getHeader('From'),
          to: getHeader('To'),
          subject: getHeader('Subject'),
          date: getHeader('Date'),
          snippet: meta.snippet || '',
        };
      })
    );

    return emails.filter(Boolean) as Array<{ id: string; threadId: string; from: string; to: string; subject: string; date: string; snippet: string }>;
  }

  async readEmail(messageId: string): Promise<{ id: string; threadId: string; from: string; to: string; subject: string; date: string; body: string; labels: string[] }> {
    const res = await this.apiFetch(`${GMAIL_BASE}/users/me/messages/${messageId}?format=full`);
    if (!res.ok) throw new Error(`Gmail API error (${res.status}): ${await res.text()}`);
    const msg = await res.json();

    const headers = (msg.payload?.headers || []) as Array<{ name: string; value: string }>;
    const getHeader = (name: string) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

    // Extract body text: check parts for text/plain, fall back to payload body
    let body = '';
    const extractText = (part: Record<string, unknown>): string => {
      if (part.mimeType === 'text/plain' && part.body && (part.body as Record<string, unknown>).data) {
        return Buffer.from((part.body as Record<string, string>).data, 'base64url').toString('utf-8');
      }
      if (Array.isArray(part.parts)) {
        for (const sub of part.parts) {
          const text = extractText(sub as Record<string, unknown>);
          if (text) return text;
        }
      }
      return '';
    };

    body = extractText(msg.payload || {});
    if (!body && msg.payload?.body?.data) {
      body = Buffer.from(msg.payload.body.data, 'base64url').toString('utf-8');
    }

    return {
      id: msg.id,
      threadId: msg.threadId,
      from: getHeader('From'),
      to: getHeader('To'),
      subject: getHeader('Subject'),
      date: getHeader('Date'),
      body,
      labels: msg.labelIds || [],
    };
  }

  async sendEmail(to: string, subject: string, body: string, cc?: string, bcc?: string): Promise<{ id: string; threadId: string }> {
    // Build RFC 2822 message
    const lines: string[] = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
    ];
    if (cc) lines.push(`Cc: ${cc}`);
    if (bcc) lines.push(`Bcc: ${bcc}`);
    lines.push('', body);

    const raw = Buffer.from(lines.join('\r\n')).toString('base64url');

    const res = await this.apiFetch(`${GMAIL_BASE}/users/me/messages/send`, {
      method: 'POST',
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) throw new Error(`Gmail API error (${res.status}): ${await res.text()}`);
    const data = await res.json();
    return { id: data.id, threadId: data.threadId };
  }

  async createDraft(to: string, subject: string, body: string, cc?: string, bcc?: string): Promise<{ id: string; draftId: string }> {
    // Build RFC 2822 message
    const lines: string[] = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
    ];
    if (cc) lines.push(`Cc: ${cc}`);
    if (bcc) lines.push(`Bcc: ${bcc}`);
    lines.push('', body);

    const raw = Buffer.from(lines.join('\r\n')).toString('base64url');

    const res = await this.apiFetch(`${GMAIL_BASE}/users/me/drafts`, {
      method: 'POST',
      body: JSON.stringify({ message: { raw } }),
    });
    if (!res.ok) throw new Error(`Gmail API error (${res.status}): ${await res.text()}`);
    const data = await res.json();
    return { id: data.message?.id || '', draftId: data.id };
  }

  async searchEmails(query: string, maxResults: number = 20): Promise<Array<{ id: string; threadId: string; from: string; to: string; subject: string; date: string; snippet: string }>> {
    return this.listEmails(maxResults, 'INBOX', query);
  }

  async archiveEmail(messageId: string): Promise<void> {
    const res = await this.apiFetch(`${GMAIL_BASE}/users/me/messages/${messageId}/modify`, {
      method: 'POST',
      body: JSON.stringify({ removeLabelIds: ['INBOX'] }),
    });
    if (!res.ok) throw new Error(`Gmail API error (${res.status}): ${await res.text()}`);
  }

  async replyToEmail(messageId: string, body: string): Promise<{ id: string; threadId: string }> {
    // Get original message for threading
    const original = await this.readEmail(messageId);

    // Build reply headers
    const lines: string[] = [
      `To: ${original.from}`,
      `Subject: Re: ${original.subject.replace(/^Re:\s*/i, '')}`,
      `In-Reply-To: ${messageId}`,
      `References: ${messageId}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ];

    const raw = Buffer.from(lines.join('\r\n')).toString('base64url');

    const res = await this.apiFetch(`${GMAIL_BASE}/users/me/messages/send`, {
      method: 'POST',
      body: JSON.stringify({ raw, threadId: original.threadId }),
    });
    if (!res.ok) throw new Error(`Gmail API error (${res.status}): ${await res.text()}`);
    const data = await res.json();
    return { id: data.id, threadId: data.threadId };
  }

  // =========================================================================
  // Contacts (People API)
  // =========================================================================

  async searchContacts(query: string, maxResults: number = 10): Promise<Array<{ resourceName: string; name: string; email: string; phone: string }>> {
    const params = new URLSearchParams({
      query,
      pageSize: String(maxResults),
      readMask: 'names,emailAddresses,phoneNumbers',
    });

    const res = await this.apiFetch(`${PEOPLE_BASE}/people:searchContacts?${params}`);
    if (!res.ok) throw new Error(`People API error (${res.status}): ${await res.text()}`);
    const data = await res.json();

    return ((data.results || []) as Array<{ person: Record<string, unknown> }>).map(r => {
      const p = r.person;
      const names = (p.names as Array<{ displayName?: string }>) || [];
      const emails = (p.emailAddresses as Array<{ value?: string }>) || [];
      const phones = (p.phoneNumbers as Array<{ value?: string }>) || [];
      return {
        resourceName: (p.resourceName as string) || '',
        name: names[0]?.displayName || '',
        email: emails[0]?.value || '',
        phone: phones[0]?.value || '',
      };
    });
  }

  async getContact(resourceName: string): Promise<{ resourceName: string; name: string; emails: string[]; phones: string[]; organizations: string[]; addresses: string[] }> {
    const params = new URLSearchParams({
      personFields: 'names,emailAddresses,phoneNumbers,organizations,addresses',
    });

    const res = await this.apiFetch(`${PEOPLE_BASE}/${resourceName}?${params}`);
    if (!res.ok) throw new Error(`People API error (${res.status}): ${await res.text()}`);
    const p = await res.json();

    return {
      resourceName: p.resourceName || resourceName,
      name: ((p.names || []) as Array<{ displayName?: string }>)[0]?.displayName || '',
      emails: ((p.emailAddresses || []) as Array<{ value?: string }>).map(e => e.value || '').filter(Boolean),
      phones: ((p.phoneNumbers || []) as Array<{ value?: string }>).map(ph => ph.value || '').filter(Boolean),
      organizations: ((p.organizations || []) as Array<{ name?: string; title?: string }>).map(o => [o.name, o.title].filter(Boolean).join(' - ')).filter(Boolean),
      addresses: ((p.addresses || []) as Array<{ formattedValue?: string }>).map(a => a.formattedValue || '').filter(Boolean),
    };
  }

  // =========================================================================
  // YouTube
  // =========================================================================

  async searchYouTube(query: string, maxResults: number = 10, type: string = 'video'): Promise<Array<{ videoId: string; title: string; description: string; channelTitle: string; publishedAt: string; thumbnailUrl: string }>> {
    const params = new URLSearchParams({
      part: 'snippet',
      q: query,
      maxResults: String(maxResults),
      type,
    });

    const res = await this.apiFetch(`${YOUTUBE_BASE}/search?${params}`);
    if (!res.ok) throw new Error(`YouTube API error (${res.status}): ${await res.text()}`);
    const data = await res.json();

    return ((data.items || []) as Array<Record<string, unknown>>).map(item => {
      const snippet = (item.snippet || {}) as Record<string, unknown>;
      const id = (item.id || {}) as Record<string, string>;
      return {
        videoId: id.videoId || id.channelId || id.playlistId || '',
        title: (snippet.title as string) || '',
        description: (snippet.description as string) || '',
        channelTitle: (snippet.channelTitle as string) || '',
        publishedAt: (snippet.publishedAt as string) || '',
        thumbnailUrl: ((snippet.thumbnails as Record<string, unknown>)?.default as Record<string, string>)?.url || '',
      };
    });
  }

  async getVideoDetails(videoId: string): Promise<{ title: string; description: string; channelTitle: string; channelId: string; publishedAt: string; duration: string; viewCount: string; likeCount: string; commentCount: string; thumbnailUrl: string }> {
    const params = new URLSearchParams({
      part: 'snippet,contentDetails,statistics',
      id: videoId,
    });

    const res = await this.apiFetch(`${YOUTUBE_BASE}/videos?${params}`);
    if (!res.ok) throw new Error(`YouTube API error (${res.status}): ${await res.text()}`);
    const data = await res.json();
    const items = (data.items || []) as Array<Record<string, unknown>>;
    if (items.length === 0) throw new Error(`Video not found: ${videoId}`);

    const item = items[0];
    const snippet = (item.snippet || {}) as Record<string, unknown>;
    const contentDetails = (item.contentDetails || {}) as Record<string, string>;
    const stats = (item.statistics || {}) as Record<string, string>;

    return {
      title: (snippet.title as string) || '',
      description: (snippet.description as string) || '',
      channelTitle: (snippet.channelTitle as string) || '',
      channelId: (snippet.channelId as string) || '',
      publishedAt: (snippet.publishedAt as string) || '',
      duration: contentDetails.duration || '',
      viewCount: stats.viewCount || '0',
      likeCount: stats.likeCount || '0',
      commentCount: stats.commentCount || '0',
      thumbnailUrl: ((snippet.thumbnails as Record<string, unknown>)?.high as Record<string, string>)?.url || '',
    };
  }

  async getChannelInfo(channelId: string): Promise<{ title: string; description: string; subscriberCount: string; videoCount: string; viewCount: string; thumbnailUrl: string; customUrl: string }> {
    const params = new URLSearchParams({
      part: 'snippet,statistics',
      id: channelId,
    });

    const res = await this.apiFetch(`${YOUTUBE_BASE}/channels?${params}`);
    if (!res.ok) throw new Error(`YouTube API error (${res.status}): ${await res.text()}`);
    const data = await res.json();
    const items = (data.items || []) as Array<Record<string, unknown>>;
    if (items.length === 0) throw new Error(`Channel not found: ${channelId}`);

    const item = items[0];
    const snippet = (item.snippet || {}) as Record<string, unknown>;
    const stats = (item.statistics || {}) as Record<string, string>;

    return {
      title: (snippet.title as string) || '',
      description: (snippet.description as string) || '',
      subscriberCount: stats.subscriberCount || '0',
      videoCount: stats.videoCount || '0',
      viewCount: stats.viewCount || '0',
      thumbnailUrl: ((snippet.thumbnails as Record<string, unknown>)?.high as Record<string, string>)?.url || '',
      customUrl: (snippet.customUrl as string) || '',
    };
  }

  async getPlaylistItems(playlistId: string, maxResults: number = 20): Promise<Array<{ videoId: string; title: string; description: string; channelTitle: string; position: number; thumbnailUrl: string }>> {
    const params = new URLSearchParams({
      part: 'snippet',
      playlistId,
      maxResults: String(maxResults),
    });

    const res = await this.apiFetch(`${YOUTUBE_BASE}/playlistItems?${params}`);
    if (!res.ok) throw new Error(`YouTube API error (${res.status}): ${await res.text()}`);
    const data = await res.json();

    return ((data.items || []) as Array<Record<string, unknown>>).map(item => {
      const snippet = (item.snippet || {}) as Record<string, unknown>;
      const resourceId = (snippet.resourceId || {}) as Record<string, string>;
      return {
        videoId: resourceId.videoId || '',
        title: (snippet.title as string) || '',
        description: (snippet.description as string) || '',
        channelTitle: (snippet.channelTitle as string) || '',
        position: (snippet.position as number) || 0,
        thumbnailUrl: ((snippet.thumbnails as Record<string, unknown>)?.default as Record<string, string>)?.url || '',
      };
    });
  }
}

// Singleton
let _instance: GoogleClient | null = null;

export function getGoogleClient(): GoogleClient {
  if (!_instance) {
    _instance = new GoogleClient();
  }
  return _instance;
}

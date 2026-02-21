"""
Google Tasks, Calendar, Sheets, Docs, and Drive Client
Handles OAuth2 authentication and API access
"""
import os
import json
import logging
import mimetypes
from datetime import datetime, timedelta, timezone
from typing import Optional, List, Dict, Any
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaFileUpload, MediaIoBaseDownload

logger = logging.getLogger(__name__)

# OAuth2 scopes
SCOPES = [
    'https://www.googleapis.com/auth/tasks',
    'https://www.googleapis.com/auth/calendar',           # upgraded from .readonly
    'https://www.googleapis.com/auth/spreadsheets',       # NEW
    'https://www.googleapis.com/auth/documents',          # NEW
    'https://www.googleapis.com/auth/drive',              # NEW
    'https://www.googleapis.com/auth/gmail.modify',       # Gmail read/send/archive
    'https://www.googleapis.com/auth/contacts.readonly',  # Google Contacts
    'https://www.googleapis.com/auth/youtube.readonly',   # YouTube search/details
]

# Paths
SCRIPT_DIR = Path(__file__).parent
CREDENTIALS_FILE = SCRIPT_DIR / 'google_auth' / 'credentials.json'
TOKEN_FILE = SCRIPT_DIR / 'google_auth' / 'token.json'


class GoogleClient:
    """Client for Google Tasks, Calendar, Sheets, Docs, and Drive APIs"""

    def __init__(self):
        self.creds: Optional[Credentials] = None
        self.tasks_service = None
        self.calendar_service = None
        self.sheets_service = None
        self.docs_service = None
        self.drive_service = None
        self.gmail_service = None
        self.people_service = None
        self.youtube_service = None
        self._authenticate()

    def _authenticate(self):
        """Authenticate with Google OAuth2"""
        # Load existing token if available
        if TOKEN_FILE.exists():
            self.creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)

        # If no valid credentials, need to authenticate
        if not self.creds or not self.creds.valid:
            if self.creds and self.creds.expired and self.creds.refresh_token:
                logger.info("Refreshing expired Google credentials")
                self.creds.refresh(Request())
            else:
                if not CREDENTIALS_FILE.exists():
                    logger.error(f"Credentials file not found: {CREDENTIALS_FILE}")
                    raise FileNotFoundError(f"Please place credentials.json in {CREDENTIALS_FILE.parent}")

                logger.info("Starting Google OAuth2 flow - browser will open")
                flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS_FILE), SCOPES)
                self.creds = flow.run_local_server(port=0)

            # Save the credentials for future use
            with open(TOKEN_FILE, 'w') as token:
                token.write(self.creds.to_json())
            logger.info("Google credentials saved")

        # Build services
        self.tasks_service = build('tasks', 'v1', credentials=self.creds)
        self.calendar_service = build('calendar', 'v3', credentials=self.creds)
        self.sheets_service = build('sheets', 'v4', credentials=self.creds)
        self.docs_service = build('docs', 'v1', credentials=self.creds)
        self.drive_service = build('drive', 'v3', credentials=self.creds)
        self.gmail_service = build('gmail', 'v1', credentials=self.creds)
        self.people_service = build('people', 'v1', credentials=self.creds)
        self.youtube_service = build('youtube', 'v3', credentials=self.creds)
        logger.info("Google API services initialized (Tasks, Calendar, Sheets, Docs, Drive, Gmail, Contacts, YouTube)")

    # =========================================================================
    # Tasks API
    # =========================================================================

    def get_task_lists(self) -> List[Dict[str, Any]]:
        """Get all task lists (e.g., Groceries, To Buy)"""
        try:
            results = self.tasks_service.tasklists().list().execute()
            task_lists = results.get('items', [])
            return [{'id': tl['id'], 'title': tl['title']} for tl in task_lists]
        except HttpError as e:
            logger.error(f"Failed to get task lists: {e}")
            return []

    def get_tasks(self, list_id: str = '@default', show_completed: bool = False) -> List[Dict[str, Any]]:
        """
        Get tasks from a specific list

        Args:
            list_id: Task list ID (use get_task_lists() to find IDs)
            show_completed: Whether to include completed tasks

        Returns:
            List of task dictionaries
        """
        try:
            results = self.tasks_service.tasks().list(
                tasklist=list_id,
                showCompleted=show_completed,
                showHidden=show_completed
            ).execute()

            tasks = results.get('items', [])
            return [{
                'id': t['id'],
                'title': t['title'],
                'notes': t.get('notes', ''),
                'due': t.get('due'),
                'status': t.get('status'),
                'completed': t.get('completed'),
            } for t in tasks]
        except HttpError as e:
            logger.error(f"Failed to get tasks: {e}")
            return []

    def get_tasks_by_list_name(self, list_name: str, show_completed: bool = False) -> List[Dict[str, Any]]:
        """Get tasks from a list by its name (case-insensitive)"""
        task_lists = self.get_task_lists()
        for tl in task_lists:
            if tl['title'].lower() == list_name.lower():
                return self.get_tasks(tl['id'], show_completed)

        logger.warning(f"Task list '{list_name}' not found")
        return []

    def add_task(self, list_id: str, title: str, notes: str = '', due_date: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
        """
        Add a new task to a list

        Args:
            list_id: Task list ID
            title: Task title
            notes: Optional notes/description
            due_date: Optional due date

        Returns:
            Created task or None on failure
        """
        try:
            task_body = {'title': title}
            if notes:
                task_body['notes'] = notes
            if due_date:
                task_body['due'] = due_date.isoformat() + 'Z'

            result = self.tasks_service.tasks().insert(
                tasklist=list_id,
                body=task_body
            ).execute()

            logger.info(f"Added task: {title}")
            return {
                'id': result['id'],
                'title': result['title'],
                'status': result.get('status'),
            }
        except HttpError as e:
            logger.error(f"Failed to add task: {e}")
            return None

    def add_task_to_list_name(self, list_name: str, title: str, notes: str = '') -> Optional[Dict[str, Any]]:
        """Add a task to a list by its name"""
        task_lists = self.get_task_lists()
        for tl in task_lists:
            if tl['title'].lower() == list_name.lower():
                return self.add_task(tl['id'], title, notes)

        logger.warning(f"Task list '{list_name}' not found")
        return None

    def complete_task(self, list_id: str, task_id: str) -> bool:
        """Mark a task as completed"""
        try:
            self.tasks_service.tasks().update(
                tasklist=list_id,
                task=task_id,
                body={'id': task_id, 'status': 'completed'}
            ).execute()
            logger.info(f"Completed task: {task_id}")
            return True
        except HttpError as e:
            logger.error(f"Failed to complete task: {e}")
            return False

    def delete_task(self, list_id: str, task_id: str) -> bool:
        """Delete a task"""
        try:
            self.tasks_service.tasks().delete(
                tasklist=list_id,
                task=task_id
            ).execute()
            logger.info(f"Deleted task: {task_id}")
            return True
        except HttpError as e:
            logger.error(f"Failed to delete task: {e}")
            return False

    # =========================================================================
    # Calendar API
    # =========================================================================

    def get_upcoming_events(self, max_results: int = 10, days_ahead: int = 7) -> List[Dict[str, Any]]:
        """
        Get upcoming calendar events

        Args:
            max_results: Maximum number of events to return
            days_ahead: How many days ahead to look

        Returns:
            List of event dictionaries
        """
        try:
            now = datetime.now(timezone.utc)
            # Format without microseconds for Google API compatibility
            time_min = now.strftime('%Y-%m-%dT%H:%M:%SZ')
            time_max = (now + timedelta(days=days_ahead)).strftime('%Y-%m-%dT%H:%M:%SZ')

            results = self.calendar_service.events().list(
                calendarId='primary',
                timeMin=time_min,
                timeMax=time_max,
                maxResults=max_results,
                singleEvents=True,
                orderBy='startTime'
            ).execute()

            events = results.get('items', [])
            return [{
                'id': e['id'],
                'summary': e.get('summary', 'No title'),
                'description': e.get('description', ''),
                'start': e['start'].get('dateTime', e['start'].get('date')),
                'end': e['end'].get('dateTime', e['end'].get('date')),
                'location': e.get('location', ''),
            } for e in events]
        except HttpError as e:
            logger.error(f"Failed to get calendar events: {e}")
            return []

    def get_todays_events(self) -> List[Dict[str, Any]]:
        """Get today's calendar events (in local timezone)"""
        try:
            # Use local time for "today", not UTC
            from datetime import datetime as dt
            import time

            # Get local timezone offset
            local_now = dt.now()
            start_of_day = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
            end_of_day = start_of_day + timedelta(days=1)

            # Format with local timezone offset
            tz_offset = time.strftime('%z')
            tz_formatted = f"{tz_offset[:3]}:{tz_offset[3:]}"  # Convert -0700 to -07:00

            results = self.calendar_service.events().list(
                calendarId='primary',
                timeMin=start_of_day.strftime(f'%Y-%m-%dT%H:%M:%S{tz_formatted}'),
                timeMax=end_of_day.strftime(f'%Y-%m-%dT%H:%M:%S{tz_formatted}'),
                singleEvents=True,
                orderBy='startTime'
            ).execute()

            events = results.get('items', [])
            return [{
                'id': e['id'],
                'summary': e.get('summary', 'No title'),
                'start': e['start'].get('dateTime', e['start'].get('date')),
                'end': e['end'].get('dateTime', e['end'].get('date')),
            } for e in events]
        except HttpError as e:
            logger.error(f"Failed to get today's events: {e}")
            return []

    def create_calendar_event(self, summary: str, start_time: str, end_time: str,
                              description: str = '', location: str = '',
                              all_day: bool = False) -> Optional[Dict[str, Any]]:
        """Create a new calendar event"""
        try:
            body: Dict[str, Any] = {'summary': summary}
            if description:
                body['description'] = description
            if location:
                body['location'] = location

            if all_day:
                # All-day events use 'date' not 'dateTime'
                body['start'] = {'date': start_time[:10]}
                body['end'] = {'date': end_time[:10]}
            else:
                body['start'] = {'dateTime': start_time, 'timeZone': 'America/Denver'}
                body['end'] = {'dateTime': end_time, 'timeZone': 'America/Denver'}

            event = self.calendar_service.events().insert(
                calendarId='primary', body=body
            ).execute()

            logger.info(f"Created calendar event: {summary}")
            return {
                'id': event['id'],
                'summary': event.get('summary', ''),
                'start': event['start'].get('dateTime', event['start'].get('date')),
                'end': event['end'].get('dateTime', event['end'].get('date')),
                'htmlLink': event.get('htmlLink', ''),
            }
        except HttpError as e:
            logger.error(f"Failed to create calendar event: {e}")
            return None

    def update_calendar_event(self, event_id: str, summary: str = None,
                              start_time: str = None, end_time: str = None,
                              description: str = None, location: str = None) -> Optional[Dict[str, Any]]:
        """Update an existing calendar event"""
        try:
            # Get existing event first
            event = self.calendar_service.events().get(
                calendarId='primary', eventId=event_id
            ).execute()

            if summary is not None:
                event['summary'] = summary
            if description is not None:
                event['description'] = description
            if location is not None:
                event['location'] = location
            if start_time is not None:
                event['start'] = {'dateTime': start_time, 'timeZone': 'America/Denver'}
            if end_time is not None:
                event['end'] = {'dateTime': end_time, 'timeZone': 'America/Denver'}

            updated = self.calendar_service.events().update(
                calendarId='primary', eventId=event_id, body=event
            ).execute()

            logger.info(f"Updated calendar event: {event_id}")
            return {
                'id': updated['id'],
                'summary': updated.get('summary', ''),
                'start': updated['start'].get('dateTime', updated['start'].get('date')),
                'end': updated['end'].get('dateTime', updated['end'].get('date')),
            }
        except HttpError as e:
            logger.error(f"Failed to update calendar event: {e}")
            return None

    def delete_calendar_event(self, event_id: str) -> bool:
        """Delete a calendar event"""
        try:
            self.calendar_service.events().delete(
                calendarId='primary', eventId=event_id
            ).execute()
            logger.info(f"Deleted calendar event: {event_id}")
            return True
        except HttpError as e:
            logger.error(f"Failed to delete calendar event: {e}")
            return False

    # =========================================================================
    # Sheets API
    # =========================================================================

    def list_spreadsheets(self, max_results: int = 20) -> List[Dict[str, Any]]:
        """List recent spreadsheets using Drive API (more reliable than Sheets list)"""
        try:
            results = self.drive_service.files().list(
                q="mimeType='application/vnd.google-apps.spreadsheet'",
                pageSize=max_results,
                fields='files(id, name, modifiedTime, webViewLink)',
                orderBy='modifiedTime desc'
            ).execute()
            files = results.get('files', [])
            return [{'id': f['id'], 'name': f['name'],
                     'modifiedTime': f.get('modifiedTime', ''),
                     'url': f.get('webViewLink', '')} for f in files]
        except HttpError as e:
            logger.error(f"Failed to list spreadsheets: {e}")
            return []

    def create_spreadsheet(self, title: str, sheet_names: List[str] = None,
                          initial_data: List[List[str]] = None) -> Optional[Dict[str, Any]]:
        """Create a new spreadsheet with optional sheet names and initial data"""
        try:
            body: Dict[str, Any] = {
                'properties': {'title': title}
            }
            if sheet_names:
                body['sheets'] = [
                    {'properties': {'title': name}} for name in sheet_names
                ]

            spreadsheet = self.sheets_service.spreadsheets().create(body=body).execute()
            ss_id = spreadsheet['spreadsheetId']

            # Write initial data if provided
            if initial_data and len(initial_data) > 0:
                sheet_title = sheet_names[0] if sheet_names else 'Sheet1'
                self.sheets_service.spreadsheets().values().update(
                    spreadsheetId=ss_id,
                    range=f'{sheet_title}!A1',
                    valueInputOption='USER_ENTERED',
                    body={'values': initial_data}
                ).execute()

            logger.info(f"Created spreadsheet: {title} ({ss_id})")
            return {
                'id': ss_id,
                'title': title,
                'url': spreadsheet.get('spreadsheetUrl', ''),
            }
        except HttpError as e:
            logger.error(f"Failed to create spreadsheet: {e}")
            return None

    def read_sheet(self, spreadsheet_id: str, range_notation: str) -> Optional[Dict[str, Any]]:
        """Read a range from a spreadsheet (A1 notation, e.g. 'Sheet1!A1:D10')"""
        try:
            result = self.sheets_service.spreadsheets().values().get(
                spreadsheetId=spreadsheet_id,
                range=range_notation
            ).execute()
            values = result.get('values', [])
            logger.info(f"Read {len(values)} rows from {spreadsheet_id}")
            return {'values': values, 'range': result.get('range', range_notation)}
        except HttpError as e:
            logger.error(f"Failed to read sheet: {e}")
            return None

    def write_sheet(self, spreadsheet_id: str, range_notation: str,
                   values: List[List[str]]) -> Optional[Dict[str, Any]]:
        """Write a 2D array to a spreadsheet range (overwrites)"""
        try:
            result = self.sheets_service.spreadsheets().values().update(
                spreadsheetId=spreadsheet_id,
                range=range_notation,
                valueInputOption='USER_ENTERED',
                body={'values': values}
            ).execute()
            logger.info(f"Wrote {result.get('updatedRows', 0)} rows to {spreadsheet_id}")
            return {
                'updatedRange': result.get('updatedRange', ''),
                'updatedRows': result.get('updatedRows', 0),
                'updatedColumns': result.get('updatedColumns', 0),
                'updatedCells': result.get('updatedCells', 0),
            }
        except HttpError as e:
            logger.error(f"Failed to write sheet: {e}")
            return None

    def append_to_sheet(self, spreadsheet_id: str, range_notation: str,
                       values: List[List[str]]) -> Optional[Dict[str, Any]]:
        """Append rows to end of a spreadsheet range"""
        try:
            result = self.sheets_service.spreadsheets().values().append(
                spreadsheetId=spreadsheet_id,
                range=range_notation,
                valueInputOption='USER_ENTERED',
                insertDataOption='INSERT_ROWS',
                body={'values': values}
            ).execute()
            updates = result.get('updates', {})
            logger.info(f"Appended {updates.get('updatedRows', 0)} rows to {spreadsheet_id}")
            return {
                'updatedRange': updates.get('updatedRange', ''),
                'updatedRows': updates.get('updatedRows', 0),
                'updatedCells': updates.get('updatedCells', 0),
            }
        except HttpError as e:
            logger.error(f"Failed to append to sheet: {e}")
            return None

    # =========================================================================
    # Docs API
    # =========================================================================

    def list_documents(self, max_results: int = 20) -> List[Dict[str, Any]]:
        """List recent Google Docs using Drive API"""
        try:
            results = self.drive_service.files().list(
                q="mimeType='application/vnd.google-apps.document'",
                pageSize=max_results,
                fields='files(id, name, modifiedTime, webViewLink)',
                orderBy='modifiedTime desc'
            ).execute()
            files = results.get('files', [])
            return [{'id': f['id'], 'name': f['name'],
                     'modifiedTime': f.get('modifiedTime', ''),
                     'url': f.get('webViewLink', '')} for f in files]
        except HttpError as e:
            logger.error(f"Failed to list documents: {e}")
            return []

    def create_document(self, title: str, content: str = '') -> Optional[Dict[str, Any]]:
        """Create a new Google Doc with plain text content"""
        try:
            doc = self.docs_service.documents().create(body={'title': title}).execute()
            doc_id = doc['documentId']

            # Insert text content if provided
            if content:
                self.docs_service.documents().batchUpdate(
                    documentId=doc_id,
                    body={'requests': [
                        {'insertText': {'location': {'index': 1}, 'text': content}}
                    ]}
                ).execute()

            logger.info(f"Created document: {title} ({doc_id})")
            return {
                'id': doc_id,
                'title': title,
                'url': f'https://docs.google.com/document/d/{doc_id}/edit',
            }
        except HttpError as e:
            logger.error(f"Failed to create document: {e}")
            return None

    def read_document(self, document_id: str) -> Optional[Dict[str, Any]]:
        """Read plain text content from a Google Doc"""
        try:
            doc = self.docs_service.documents().get(documentId=document_id).execute()
            # Extract text from document body
            text = ''
            for element in doc.get('body', {}).get('content', []):
                if 'paragraph' in element:
                    for pe in element['paragraph'].get('elements', []):
                        if 'textRun' in pe:
                            text += pe['textRun']['content']
            return {
                'title': doc.get('title', ''),
                'content': text,
                'id': document_id,
            }
        except HttpError as e:
            logger.error(f"Failed to read document: {e}")
            return None

    def append_to_document(self, document_id: str, text: str) -> Optional[Dict[str, Any]]:
        """Append text to end of an existing Google Doc"""
        try:
            # Get current doc to find end index
            doc = self.docs_service.documents().get(documentId=document_id).execute()
            end_index = doc['body']['content'][-1]['endIndex'] - 1

            self.docs_service.documents().batchUpdate(
                documentId=document_id,
                body={'requests': [
                    {'insertText': {'location': {'index': end_index}, 'text': text}}
                ]}
            ).execute()

            logger.info(f"Appended {len(text)} chars to document {document_id}")
            return {
                'id': document_id,
                'title': doc.get('title', ''),
                'appendedLength': len(text),
            }
        except HttpError as e:
            logger.error(f"Failed to append to document: {e}")
            return None

    # =========================================================================
    # Drive API
    # =========================================================================

    def list_drive_files(self, folder_id: str = None, max_results: int = 20) -> List[Dict[str, Any]]:
        """List files in Drive (optionally in a specific folder)"""
        try:
            q = f"'{folder_id}' in parents" if folder_id else None
            results = self.drive_service.files().list(
                q=q,
                pageSize=max_results,
                fields='files(id, name, mimeType, modifiedTime, size, webViewLink)',
                orderBy='modifiedTime desc'
            ).execute()
            files = results.get('files', [])
            return [{
                'id': f['id'],
                'name': f['name'],
                'mimeType': f.get('mimeType', ''),
                'modifiedTime': f.get('modifiedTime', ''),
                'size': f.get('size', ''),
                'url': f.get('webViewLink', ''),
            } for f in files]
        except HttpError as e:
            logger.error(f"Failed to list drive files: {e}")
            return []

    def search_drive(self, query: str, max_results: int = 20) -> List[Dict[str, Any]]:
        """Search files by name in Drive"""
        try:
            results = self.drive_service.files().list(
                q=f"name contains '{query}'",
                pageSize=max_results,
                fields='files(id, name, mimeType, modifiedTime, size, webViewLink)',
                orderBy='modifiedTime desc'
            ).execute()
            files = results.get('files', [])
            return [{
                'id': f['id'],
                'name': f['name'],
                'mimeType': f.get('mimeType', ''),
                'modifiedTime': f.get('modifiedTime', ''),
                'size': f.get('size', ''),
                'url': f.get('webViewLink', ''),
            } for f in files]
        except HttpError as e:
            logger.error(f"Failed to search drive: {e}")
            return []

    def create_drive_folder(self, name: str, parent_id: str = None) -> Optional[Dict[str, Any]]:
        """Create a folder in Drive"""
        try:
            body: Dict[str, Any] = {
                'name': name,
                'mimeType': 'application/vnd.google-apps.folder',
            }
            if parent_id:
                body['parents'] = [parent_id]

            folder = self.drive_service.files().create(
                body=body, fields='id, name, webViewLink'
            ).execute()

            logger.info(f"Created Drive folder: {name} ({folder['id']})")
            return {
                'id': folder['id'],
                'name': folder['name'],
                'url': folder.get('webViewLink', ''),
            }
        except HttpError as e:
            logger.error(f"Failed to create drive folder: {e}")
            return None

    def upload_to_drive(self, file_path: str, folder_id: str = None,
                       drive_filename: str = None) -> Optional[Dict[str, Any]]:
        """Upload a local file to Drive"""
        try:
            import io
            path = Path(file_path)
            if not path.exists():
                logger.error(f"File not found: {file_path}")
                return None

            mime_type = mimetypes.guess_type(str(path))[0] or 'application/octet-stream'
            body: Dict[str, Any] = {
                'name': drive_filename or path.name,
            }
            if folder_id:
                body['parents'] = [folder_id]

            media = MediaFileUpload(str(path), mimetype=mime_type, resumable=True)
            file = self.drive_service.files().create(
                body=body, media_body=media, fields='id, name, webViewLink, size'
            ).execute()

            logger.info(f"Uploaded to Drive: {file['name']} ({file['id']})")
            return {
                'id': file['id'],
                'name': file['name'],
                'url': file.get('webViewLink', ''),
                'size': file.get('size', ''),
            }
        except HttpError as e:
            logger.error(f"Failed to upload to drive: {e}")
            return None

    def download_from_drive(self, file_id: str, output_path: str) -> Optional[str]:
        """Download a file from Drive to local path. Google Docs exported as plain text, Sheets as CSV."""
        try:
            import io
            # Get file metadata to check type
            meta = self.drive_service.files().get(fileId=file_id, fields='mimeType, name').execute()
            mime = meta.get('mimeType', '')

            output = Path(output_path)
            output.parent.mkdir(parents=True, exist_ok=True)

            if mime == 'application/vnd.google-apps.document':
                # Export Google Doc as plain text
                content = self.drive_service.files().export(
                    fileId=file_id, mimeType='text/plain'
                ).execute()
                output.write_bytes(content)
            elif mime == 'application/vnd.google-apps.spreadsheet':
                # Export Google Sheet as CSV
                content = self.drive_service.files().export(
                    fileId=file_id, mimeType='text/csv'
                ).execute()
                output.write_bytes(content)
            else:
                # Binary download for regular files
                request = self.drive_service.files().get_media(fileId=file_id)
                fh = io.FileIO(str(output), 'wb')
                downloader = MediaIoBaseDownload(fh, request)
                done = False
                while not done:
                    _, done = downloader.next_chunk()
                fh.close()

            logger.info(f"Downloaded from Drive: {meta.get('name', file_id)} -> {output_path}")
            return str(output)
        except HttpError as e:
            logger.error(f"Failed to download from drive: {e}")
            return None

    # =========================================================================
    # Gmail API
    # =========================================================================

    def list_emails(self, max_results: int = 20, label: str = 'INBOX', query: str = None) -> List[Dict[str, Any]]:
        """List recent emails with summary info"""
        try:
            kwargs = {'userId': 'me', 'maxResults': max_results, 'labelIds': [label]}
            if query:
                kwargs['q'] = query
            results = self.gmail_service.users().messages().list(**kwargs).execute()
            messages = results.get('messages', [])

            emails = []
            for msg in messages[:max_results]:
                meta = self.gmail_service.users().messages().get(
                    userId='me', id=msg['id'], format='metadata',
                    metadataHeaders=['From', 'To', 'Subject', 'Date']
                ).execute()
                headers = {h['name']: h['value'] for h in meta.get('payload', {}).get('headers', [])}
                emails.append({
                    'id': meta['id'],
                    'threadId': meta['threadId'],
                    'from': headers.get('From', ''),
                    'to': headers.get('To', ''),
                    'subject': headers.get('Subject', ''),
                    'date': headers.get('Date', ''),
                    'snippet': meta.get('snippet', ''),
                })
            return emails
        except HttpError as e:
            logger.error(f"Failed to list emails: {e}")
            return []

    def read_email(self, message_id: str) -> Optional[Dict[str, Any]]:
        """Read full email content"""
        try:
            import base64
            msg = self.gmail_service.users().messages().get(
                userId='me', id=message_id, format='full'
            ).execute()
            headers = {h['name']: h['value'] for h in msg.get('payload', {}).get('headers', [])}

            # Extract body text
            def extract_text(part):
                if part.get('mimeType') == 'text/plain' and part.get('body', {}).get('data'):
                    return base64.urlsafe_b64decode(part['body']['data']).decode('utf-8')
                for sub in part.get('parts', []):
                    text = extract_text(sub)
                    if text:
                        return text
                return ''

            body = extract_text(msg.get('payload', {}))
            if not body and msg.get('payload', {}).get('body', {}).get('data'):
                body = base64.urlsafe_b64decode(msg['payload']['body']['data']).decode('utf-8')

            return {
                'id': msg['id'],
                'threadId': msg['threadId'],
                'from': headers.get('From', ''),
                'to': headers.get('To', ''),
                'subject': headers.get('Subject', ''),
                'date': headers.get('Date', ''),
                'body': body,
                'labels': msg.get('labelIds', []),
            }
        except HttpError as e:
            logger.error(f"Failed to read email: {e}")
            return None

    def send_email(self, to: str, subject: str, body: str, cc: str = None, bcc: str = None) -> Optional[Dict[str, Any]]:
        """Send a new email"""
        try:
            import base64
            from email.mime.text import MIMEText

            message = MIMEText(body)
            message['to'] = to
            message['subject'] = subject
            if cc:
                message['cc'] = cc
            if bcc:
                message['bcc'] = bcc

            raw = base64.urlsafe_b64encode(message.as_bytes()).decode('utf-8')
            result = self.gmail_service.users().messages().send(
                userId='me', body={'raw': raw}
            ).execute()

            logger.info(f"Sent email to {to}: {subject}")
            return {'id': result['id'], 'threadId': result['threadId']}
        except HttpError as e:
            logger.error(f"Failed to send email: {e}")
            return None

    def create_draft(self, to: str, subject: str, body: str, cc: str = None, bcc: str = None) -> Optional[Dict[str, Any]]:
        """Create an email draft without sending"""
        try:
            import base64
            from email.mime.text import MIMEText

            message = MIMEText(body)
            message['to'] = to
            message['subject'] = subject
            if cc:
                message['cc'] = cc
            if bcc:
                message['bcc'] = bcc

            raw = base64.urlsafe_b64encode(message.as_bytes()).decode('utf-8')
            result = self.gmail_service.users().drafts().create(
                userId='me', body={'message': {'raw': raw}}
            ).execute()

            logger.info(f"Created draft to {to}: {subject}")
            return {'id': result.get('message', {}).get('id', ''), 'draftId': result['id']}
        except HttpError as e:
            logger.error(f"Failed to create draft: {e}")
            return None

    def search_emails(self, query: str, max_results: int = 20) -> List[Dict[str, Any]]:
        """Search emails using Gmail search syntax"""
        return self.list_emails(max_results=max_results, label='INBOX', query=query)

    def archive_email(self, message_id: str) -> bool:
        """Archive an email (remove INBOX label)"""
        try:
            self.gmail_service.users().messages().modify(
                userId='me', id=message_id,
                body={'removeLabelIds': ['INBOX']}
            ).execute()
            logger.info(f"Archived email: {message_id}")
            return True
        except HttpError as e:
            logger.error(f"Failed to archive email: {e}")
            return False

    def reply_to_email(self, message_id: str, body: str) -> Optional[Dict[str, Any]]:
        """Reply to an existing email thread"""
        try:
            import base64
            from email.mime.text import MIMEText

            # Get original message for threading info
            original = self.read_email(message_id)
            if not original:
                return None

            message = MIMEText(body)
            message['to'] = original['from']
            message['subject'] = f"Re: {original['subject'].lstrip('Re: ')}"
            message['In-Reply-To'] = message_id
            message['References'] = message_id

            raw = base64.urlsafe_b64encode(message.as_bytes()).decode('utf-8')
            result = self.gmail_service.users().messages().send(
                userId='me', body={'raw': raw, 'threadId': original['threadId']}
            ).execute()

            logger.info(f"Replied to email: {message_id}")
            return {'id': result['id'], 'threadId': result['threadId']}
        except HttpError as e:
            logger.error(f"Failed to reply to email: {e}")
            return None

    # =========================================================================
    # Contacts (People) API
    # =========================================================================

    def search_contacts(self, query: str, max_results: int = 10) -> List[Dict[str, Any]]:
        """Search contacts by name or email"""
        try:
            results = self.people_service.people().searchContacts(
                query=query,
                pageSize=max_results,
                readMask='names,emailAddresses,phoneNumbers'
            ).execute()

            contacts = []
            for r in results.get('results', []):
                person = r.get('person', {})
                names = person.get('names', [])
                emails = person.get('emailAddresses', [])
                phones = person.get('phoneNumbers', [])
                contacts.append({
                    'resourceName': person.get('resourceName', ''),
                    'name': names[0].get('displayName', '') if names else '',
                    'email': emails[0].get('value', '') if emails else '',
                    'phone': phones[0].get('value', '') if phones else '',
                })
            return contacts
        except HttpError as e:
            logger.error(f"Failed to search contacts: {e}")
            return []

    def get_contact(self, resource_name: str) -> Optional[Dict[str, Any]]:
        """Get full contact details"""
        try:
            person = self.people_service.people().get(
                resourceName=resource_name,
                personFields='names,emailAddresses,phoneNumbers,organizations,addresses'
            ).execute()

            names = person.get('names', [])
            emails = person.get('emailAddresses', [])
            phones = person.get('phoneNumbers', [])
            orgs = person.get('organizations', [])
            addrs = person.get('addresses', [])

            return {
                'resourceName': person.get('resourceName', resource_name),
                'name': names[0].get('displayName', '') if names else '',
                'emails': [e.get('value', '') for e in emails],
                'phones': [p.get('value', '') for p in phones],
                'organizations': [f"{o.get('name', '')} - {o.get('title', '')}".strip(' -') for o in orgs],
                'addresses': [a.get('formattedValue', '') for a in addrs],
            }
        except HttpError as e:
            logger.error(f"Failed to get contact: {e}")
            return None

    # =========================================================================
    # YouTube API
    # =========================================================================

    def search_youtube(self, query: str, max_results: int = 10, type: str = 'video') -> List[Dict[str, Any]]:
        """Search YouTube for videos, channels, or playlists"""
        try:
            results = self.youtube_service.search().list(
                part='snippet',
                q=query,
                maxResults=max_results,
                type=type
            ).execute()

            items = []
            for item in results.get('items', []):
                snippet = item.get('snippet', {})
                item_id = item.get('id', {})
                items.append({
                    'videoId': item_id.get('videoId', item_id.get('channelId', item_id.get('playlistId', ''))),
                    'title': snippet.get('title', ''),
                    'description': snippet.get('description', ''),
                    'channelTitle': snippet.get('channelTitle', ''),
                    'publishedAt': snippet.get('publishedAt', ''),
                    'thumbnailUrl': snippet.get('thumbnails', {}).get('default', {}).get('url', ''),
                })
            return items
        except HttpError as e:
            logger.error(f"Failed to search YouTube: {e}")
            return []

    def get_video_details(self, video_id: str) -> Optional[Dict[str, Any]]:
        """Get detailed info about a YouTube video"""
        try:
            results = self.youtube_service.videos().list(
                part='snippet,contentDetails,statistics',
                id=video_id
            ).execute()

            items = results.get('items', [])
            if not items:
                return None

            item = items[0]
            snippet = item.get('snippet', {})
            content = item.get('contentDetails', {})
            stats = item.get('statistics', {})

            return {
                'title': snippet.get('title', ''),
                'description': snippet.get('description', ''),
                'channelTitle': snippet.get('channelTitle', ''),
                'channelId': snippet.get('channelId', ''),
                'publishedAt': snippet.get('publishedAt', ''),
                'duration': content.get('duration', ''),
                'viewCount': stats.get('viewCount', '0'),
                'likeCount': stats.get('likeCount', '0'),
                'commentCount': stats.get('commentCount', '0'),
                'thumbnailUrl': snippet.get('thumbnails', {}).get('high', {}).get('url', ''),
            }
        except HttpError as e:
            logger.error(f"Failed to get video details: {e}")
            return None

    def get_channel_info(self, channel_id: str) -> Optional[Dict[str, Any]]:
        """Get info about a YouTube channel"""
        try:
            results = self.youtube_service.channels().list(
                part='snippet,statistics',
                id=channel_id
            ).execute()

            items = results.get('items', [])
            if not items:
                return None

            item = items[0]
            snippet = item.get('snippet', {})
            stats = item.get('statistics', {})

            return {
                'title': snippet.get('title', ''),
                'description': snippet.get('description', ''),
                'subscriberCount': stats.get('subscriberCount', '0'),
                'videoCount': stats.get('videoCount', '0'),
                'viewCount': stats.get('viewCount', '0'),
                'thumbnailUrl': snippet.get('thumbnails', {}).get('high', {}).get('url', ''),
                'customUrl': snippet.get('customUrl', ''),
            }
        except HttpError as e:
            logger.error(f"Failed to get channel info: {e}")
            return None

    def get_playlist_items(self, playlist_id: str, max_results: int = 20) -> List[Dict[str, Any]]:
        """List videos in a YouTube playlist"""
        try:
            results = self.youtube_service.playlistItems().list(
                part='snippet',
                playlistId=playlist_id,
                maxResults=max_results
            ).execute()

            items = []
            for item in results.get('items', []):
                snippet = item.get('snippet', {})
                resource_id = snippet.get('resourceId', {})
                items.append({
                    'videoId': resource_id.get('videoId', ''),
                    'title': snippet.get('title', ''),
                    'description': snippet.get('description', ''),
                    'channelTitle': snippet.get('channelTitle', ''),
                    'position': snippet.get('position', 0),
                    'thumbnailUrl': snippet.get('thumbnails', {}).get('default', {}).get('url', ''),
                })
            return items
        except HttpError as e:
            logger.error(f"Failed to get playlist items: {e}")
            return []


# Singleton instance
_google_client: Optional[GoogleClient] = None


def get_google_client() -> GoogleClient:
    """Get or create the Google client singleton"""
    global _google_client
    if _google_client is None:
        _google_client = GoogleClient()
    return _google_client


# =========================================================================
# CLI for testing and initial auth
# =========================================================================

if __name__ == '__main__':
    import sys

    logging.basicConfig(level=logging.INFO)

    print("Google Tasks/Calendar/Sheets/Docs/Drive Client")
    print("=" * 50)

    # Initialize (will trigger OAuth flow if needed)
    client = get_google_client()

    print("\nTask Lists:")
    for tl in client.get_task_lists():
        print(f"  - {tl['title']} ({tl['id']})")

    print("\nToday's Calendar Events:")
    for event in client.get_todays_events():
        print(f"  - {event['summary']} at {event['start']}")

    print("\nUpcoming Events (7 days):")
    for event in client.get_upcoming_events():
        print(f"  - {event['summary']} at {event['start']}")

    print("\nRecent Spreadsheets:")
    for ss in client.list_spreadsheets(5):
        print(f"  - {ss['name']} ({ss['id'][:12]}...)")

    print("\nRecent Documents:")
    for doc in client.list_documents(5):
        print(f"  - {doc['name']} ({doc['id'][:12]}...)")

    print("\nRecent Drive Files:")
    for f in client.list_drive_files(max_results=5):
        print(f"  - {f['name']} ({f['mimeType']})")

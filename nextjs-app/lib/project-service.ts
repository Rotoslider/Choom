/**
 * Project Service
 * Manages project folders in the workspace root.
 * Each project can have a `.choom-project.json` metadata file.
 */

import { readFile, writeFile, readdir, stat, mkdir, rm, rename } from 'fs/promises';
import path from 'path';

export interface ProjectMetadata {
  name: string;
  description?: string;
  created?: string;
  lastModified?: string;
  assignedChoom?: string;
  status: 'active' | 'paused' | 'complete';
  maxIterations?: number;
  llmProviderId?: string;  // Provider ID from settings.providers
  llmModel?: string;       // Model override for this project
}

export interface ProjectInfo {
  folder: string;
  metadata: ProjectMetadata;
  fileCount: number;
  totalSizeKB: number;
}

const META_FILE = '.choom-project.json';

export class ProjectService {
  private rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = path.resolve(rootPath);
  }

  /** List all projects (folders in the workspace root) */
  async listProjects(): Promise<ProjectInfo[]> {
    await mkdir(this.rootPath, { recursive: true });
    const entries = await readdir(this.rootPath, { withFileTypes: true });
    const projects: ProjectInfo[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const folderPath = path.join(this.rootPath, entry.name);
      const metadata = await this.readMetadata(entry.name);
      const { fileCount, totalSize } = await this.getFolderStats(folderPath);

      projects.push({
        folder: entry.name,
        metadata: metadata || {
          name: entry.name,
          status: 'active',
        },
        fileCount,
        totalSizeKB: Math.round(totalSize / 1024),
      });
    }

    return projects.sort((a, b) => {
      const aTime = a.metadata.lastModified || '';
      const bTime = b.metadata.lastModified || '';
      return bTime.localeCompare(aTime);
    });
  }

  /** Get a single project by folder name */
  async getProject(folder: string): Promise<ProjectInfo | null> {
    // Decode URL-encoded characters (LLMs sometimes encode spaces as %20)
    folder = decodeURIComponent(folder);
    const folderPath = path.join(this.rootPath, folder);
    try {
      const stats = await stat(folderPath);
      if (!stats.isDirectory()) return null;
    } catch {
      return null;
    }

    const metadata = await this.readMetadata(folder);
    const { fileCount, totalSize } = await this.getFolderStats(folderPath);

    return {
      folder,
      metadata: metadata || { name: folder, status: 'active' },
      fileCount,
      totalSizeKB: Math.round(totalSize / 1024),
    };
  }

  /** Update project metadata (merge with existing) */
  async updateProjectMetadata(folder: string, updates: Partial<ProjectMetadata>): Promise<ProjectMetadata> {
    // Decode URL-encoded characters (LLMs sometimes encode spaces as %20)
    folder = decodeURIComponent(folder);
    const existing = await this.readMetadata(folder) || {
      name: folder,
      status: 'active' as const,
      created: new Date().toISOString(),
    };

    const merged: ProjectMetadata = {
      ...existing,
      ...updates,
      lastModified: new Date().toISOString(),
    };

    const metaPath = path.join(this.rootPath, folder, META_FILE);
    await writeFile(metaPath, JSON.stringify(merged, null, 2), 'utf-8');
    return merged;
  }

  /** Create a new project folder with optional metadata */
  async createProject(name: string, metadata?: Partial<ProjectMetadata>): Promise<ProjectInfo> {
    // Sanitize folder name: replace spaces with underscores for Linux compatibility
    const folderName = name.replace(/\s+/g, '_');
    const folderPath = path.join(this.rootPath, folderName);
    await mkdir(folderPath, { recursive: true });

    const now = new Date().toISOString();
    const meta: ProjectMetadata = {
      name,
      status: 'active',
      created: now,
      lastModified: now,
      ...metadata,
    };

    const metaPath = path.join(folderPath, META_FILE);
    await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

    return {
      folder: folderName,
      metadata: meta,
      fileCount: 1, // the meta file
      totalSizeKB: 0,
    };
  }

  /** Rename a project folder and update its metadata */
  async renameProject(oldFolder: string, newName: string): Promise<ProjectInfo> {
    oldFolder = decodeURIComponent(oldFolder);
    const oldPath = path.resolve(this.rootPath, oldFolder);

    // Safety: ensure the old path is inside workspace
    if (!oldPath.startsWith(this.rootPath)) {
      throw new Error('Invalid project folder path');
    }

    // Verify old folder exists
    const stats = await stat(oldPath);
    if (!stats.isDirectory()) {
      throw new Error(`"${oldFolder}" is not a directory`);
    }

    // Sanitize new folder name
    const newFolder = newName.replace(/\s+/g, '_');
    const newPath = path.resolve(this.rootPath, newFolder);

    // Safety: ensure new path stays inside workspace
    if (!newPath.startsWith(this.rootPath)) {
      throw new Error('Invalid new project name');
    }

    // Check new name doesn't already exist
    try {
      await stat(newPath);
      throw new Error(`A project named "${newFolder}" already exists`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // ENOENT = doesn't exist, which is what we want
    }

    // Rename the folder
    await rename(oldPath, newPath);

    // Update metadata with new name
    const metadata = await this.readMetadata(newFolder) || {
      name: newName,
      status: 'active' as const,
    };
    metadata.name = newName;
    metadata.lastModified = new Date().toISOString();

    const metaPath = path.join(newPath, META_FILE);
    await writeFile(metaPath, JSON.stringify(metadata, null, 2), 'utf-8');

    const { fileCount, totalSize } = await this.getFolderStats(newPath);
    return {
      folder: newFolder,
      metadata,
      fileCount,
      totalSizeKB: Math.round(totalSize / 1024),
    };
  }

  /** Delete a project folder and all its contents */
  async deleteProject(folder: string): Promise<void> {
    folder = decodeURIComponent(folder);
    const folderPath = path.join(this.rootPath, folder);

    // Safety: ensure the folder is inside the root path
    const resolvedPath = path.resolve(folderPath);
    if (!resolvedPath.startsWith(this.rootPath)) {
      throw new Error('Invalid project folder path');
    }

    // Verify it exists and is a directory
    const stats = await stat(folderPath);
    if (!stats.isDirectory()) {
      throw new Error('Not a directory');
    }

    await rm(folderPath, { recursive: true, force: true });
  }

  /** Read .choom-project.json for a folder */
  private async readMetadata(folder: string): Promise<ProjectMetadata | null> {
    const metaPath = path.join(this.rootPath, folder, META_FILE);
    try {
      const raw = await readFile(metaPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** Count files and total size in a folder (non-recursive, top-level only) */
  private async getFolderStats(folderPath: string): Promise<{ fileCount: number; totalSize: number }> {
    let fileCount = 0;
    let totalSize = 0;

    try {
      const entries = await readdir(folderPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          fileCount++;
          try {
            const stats = await stat(path.join(folderPath, entry.name));
            totalSize += stats.size;
          } catch { /* skip unreadable files */ }
        } else if (entry.isDirectory()) {
          // Recursively count subdirectory contents
          const sub = await this.getFolderStats(path.join(folderPath, entry.name));
          fileCount += sub.fileCount;
          totalSize += sub.totalSize;
        }
      }
    } catch { /* folder may not exist */ }

    return { fileCount, totalSize };
  }
}

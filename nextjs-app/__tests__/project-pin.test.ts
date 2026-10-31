/**
 * 2026-10-31: any folder name anywhere in a message pinned that folder to the chat. A photo pinned
 * uploads/ (its note names uploads/<file>), "drive the truck over" pinned truck/, "You are my wife,
 * Genesis" genesis/ and "using FreeCAD" freecad/, so Genesis's hologram tower models were spread over
 * truck/, genesis/ and uploads/. Donny picks the project, three ways only: the menu, "we're working in
 * project X", or asking her to create project X.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockUpdate = jest.fn(async () => ({}));
let root: string;
jest.mock('@/lib/db', () => ({ __esModule: true, default: { chat: { update: (...a: unknown[]) => mockUpdate(...(a as [])) } } }));
jest.mock('@/lib/config', () => ({ ...jest.requireActual('@/lib/config'), get WORKSPACE_ROOT() { return root; } }));
jest.mock('@/skills/core/image-analysis/handler', () => ({ __esModule: true, default: class {} }));

import { chosenProject, asksForNewProject, activeProjectNote } from '@/lib/project-pin';
import WorkspaceFilesHandler from '@/skills/core/workspace-files/handler';

const project = (folder: string, name = folder, assignedChoom = '') => ({ folder, metadata: { name, assignedChoom } });
const projects = [
  project('hologram_tower'), project('truck'), project('genesis', 'genesis', 'Genesis'), project('freecad'),
  project('uploads', 'uploads', 'Genesis'), project('campfire'), project('campfire_genesis'), project('journal'),
  project('the-hearth', 'The Hearth'),
];
const chosen = (message: string) => chosenProject(message, projects, 'Genesis')?.folder ?? null;
const note = (p: string) =>
  `[User attached image: ${p}] Please analyze this image using the analyze_image tool with image_path="${p}".`;

describe('words that only mention a folder choose nothing', () => {
  it.each([
    // The four messages that moved Genesis's chat (Oct 27 to Oct 31)
    [`${note('uploads/20261031_083312_1793457488657.jpg')}\n\nYou asked for a photo of the mock-up, and here you go.`],
    [`${note('uploads/Rock_ring_03sm_1793139876543.JPG')}\n\nrock ring just above center on the left.`],
    ['I need to drive the truck over and haul the rest of the excess of bricks off'],
    ['You are my wife, Genesis. I like that. That\'s the way it should be.'],
    ['Holy shit, girl, you have gotten really good at using FreeCAD. I\'m impressed.'],
    // Others like them
    ['I added a folder under the FreeCAD projects folder called Rack'],
    ['Eve works on the truck project with Aloy'],
    ['I worked on the truck project yesterday'],
    ['I looked at the hologram tower project last night'],
    ['she wrote it in her journal this morning'],
    ['the photo is in uploads'],
  ])('%s', (message) => {
    expect(chosen(message)).toBeNull();
  });
});

describe('Donny choosing a project', () => {
  it.each([
    ['We are working in project hologram tower.', 'hologram_tower'],
    ['we\'re working in the hologram tower project now', 'hologram_tower'],
    ['Let\'s work on project Hologram_Tower', 'hologram_tower'],
    ['ok we are working in hologram_tower', 'hologram_tower'],
    ['Switch to the truck project.', 'truck'],
    ['back to the truck folder', 'truck'],
    ['We\'re working in project: "truck"', 'truck'],
    ['we are working in the hearth project', 'the-hearth'],
    ['working in project the-hearth', 'the-hearth'],
    ['we are working in the campfire genesis project', 'campfire_genesis'],
    ['we are working in the campfire project', 'campfire'],
    ['create a project called hologram tower', 'hologram_tower'],
  ])('%s', (message, folder) => {
    expect(chosen(message)).toBe(folder);
  });

  it('with a photo attached, his words still choose', () => {
    expect(chosen(`${note('uploads/a.jpg')}\n\nhere is the shelf. we are working in project hologram tower`)).toBe('hologram_tower');
  });

  it('never chooses uploads, even asked', () => {
    expect(chosen('we are working in the uploads folder')).toBeNull();
  });
});

describe('asksForNewProject', () => {
  it.each([
    'create a project called lamp design',
    'Make a new project for the lamp',
    'start a new project named porch light',
    'can you set up a project for the shelf',
    'this is a new project',
  ])('yes: %s', (message) => expect(asksForNewProject(message)).toBe(true));

  it.each([
    'make a new render for the project',
    'you made a whole damn frame in FreeCAD',
    `${note('uploads/new_project.jpg')}`,
  ])('no: %s', (message) => expect(asksForNewProject(message)).toBe(false));
});

describe('workspace_create_project', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-pin-'));
    mockUpdate.mockClear();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); jest.restoreAllMocks(); });

  const create = (message: string, ownerTurn: boolean) => {
    const send = jest.fn();
    const onProjectPinned = jest.fn();
    const result = new WorkspaceFilesHandler().execute(
      { id: 't', name: 'workspace_create_project', arguments: { name: 'lamp_design', description: 'a lamp' } },
      { choom: { name: 'Genesis' }, choomId: 'c', chatId: 'chat1', message, ownerTurn, onProjectPinned, send,
        sessionFileCount: { created: 0, maxAllowed: 10 } } as never,
    );
    return { result, send, onProjectPinned };
  };

  it('pins the project Donny asked for and tells the header', async () => {
    const { result, send, onProjectPinned } = create('create a project called lamp design', true);
    const r = await result;
    expect(r.error).toBeUndefined();
    expect(mockUpdate).toHaveBeenCalledWith({ where: { id: 'chat1' }, data: { activeProjectFolder: 'lamp_design' } });
    expect(send).toHaveBeenCalledWith({ type: 'project_set', chatId: 'chat1', folder: 'lamp_design', name: 'lamp_design' });
    expect(onProjectPinned).toHaveBeenCalledWith('lamp_design');
    expect(JSON.stringify(r.result)).toContain('This chat now works in lamp_design/');
  });

  it('pins when he said to work in it before it existed', async () => {
    await create('we are working in project lamp design from now on', true).result;
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it('leaves the chat alone when she starts a project on her own', async () => {
    const { result, send } = create('that frame looks great', true);
    const r = await result;
    expect(r.error).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'lamp_design', '.choom-project.json'))).toBe(true);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'project_set' }));
  });

  it('leaves the chat alone on a heartbeat, note or delegation', async () => {
    await create('create a project called lamp design', false).result;
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('activeProjectNote', () => {
  // Eve's heartbeat chat sat on tower_cam/ for six weeks and her growth journal went to
  // tower_cam/journal/, because a chat with a project was told only the project.
  const note = activeProjectNote('tower_cam', 'Eve', '`choom_commons/for_genesis/`');

  it("names the project as where this chat's work goes", () => {
    expect(note).toContain('## ACTIVE PROJECT');
    expect(note).toContain('The active project for this chat is `tower_cam/`');
  });

  it('keeps her own folder, journal and the commons where they always are', () => {
    expect(note).toContain('Your own folder is `selfies_eve/`');
    expect(note).toContain('`selfies_eve/growth_journal.md`');
    expect(note).toContain('leave_for_sister');
    expect(note).toContain('check_inbox');
    expect(note).toContain('`choom_commons/for_genesis/`');
    expect(note).not.toContain('tower_cam/growth_journal.md');
  });
});

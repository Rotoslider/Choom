/**
 * How a chat's project is chosen. Donny picks it, and only three ways: the menu at the top of the
 * chat (PUT /api/chats/[id]), telling her "we're working in project X", or telling her to create
 * project X (skills/core/workspace-files createProject). The pinned project is where her work goes:
 * the FreeCAD tool saves to <project>/freecad/, and a task she hands a sister says to work there.
 *
 * Until 2026-10-31 any folder name anywhere in a message pinned that folder. Photos pinned uploads/
 * (the note before an attached image names uploads/<file>), and ordinary words moved her: "drive the
 * truck over" pinned truck/, "You are my wife, Genesis" genesis/, "using FreeCAD" freecad/, so her
 * hologram tower models were spread over truck/, genesis/ and uploads/.
 */
import prisma from '@/lib/db';

type Project = { folder: string; metadata: { name?: string; assignedChoom?: string } };

/** The note before an attached image (components/chat/chat-interface.tsx, signal-bridge image_context_note). */
const ATTACHED_IMAGE_NOTE =
  /\[User attached image: [^\]\n]*\](?: Please analyze this image using the analyze_image tool with image_path="[^"\n]*"\.)?/g;

/** Folders a message never pins: they hold files for every chat. The menu can still pick one. */
const NEVER_PINNED = new Set(['uploads']);

/** Words that choose a project when "project" or "folder" goes with its name: working in, switch to, create ... */
const CHOOSING = String.raw`(?:working\s+(?:in|on|out\s+of|from|with)|work\s+(?:in|on|out\s+of|from|with)|switch(?:ing)?(?:\s+(?:over|back))*\s+to|mov(?:e|ing)(?:\s+(?:over|back))*\s+to|back\s+to|chang(?:e|ing)(?:\s+it)?\s+to|us(?:e|ing)|open(?:ing)?|continu(?:e|ing)(?:\s+(?:on|with|in))?|creat(?:e|ing)|mak(?:e|ing)|start(?:ing)?|set(?:ting)?\s*up|begin(?:ning)?)`;
const CREATING = String.raw`(?:creat(?:e|ing)|mak(?:e|ing)|start(?:ing)?|set(?:ting)?\s*up|begin(?:ning)?|spin(?:ning)?\s+up)`;
const LEAD_IN = String.raw`(?:(?:the|our|my|your|a|an|new|that|this)\s+)*`;
const QUOTE = String.raw`["'\`“”‘’]?`;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Donny's own words: the attached-image notes dropped, lowercased. */
export function ownWords(message: string): string {
  return message.replace(ATTACHED_IMAGE_NOTE, ' ').toLowerCase();
}

/** "hologram_tower" or "Hologram Tower" as a pattern that takes spaces, _ or - between its words. */
function namePattern(name: string): string | null {
  const words = name.toLowerCase().split(/[\s_-]+/).filter(Boolean);
  return words.length ? words.map(escape).join(String.raw`[\s_-]+`) : null;
}

/** Whether the words choose this name: "working in project X", "the X project", "create a project called X". */
function choosesName(words: string, name: string): boolean {
  const n = namePattern(name);
  if (!n) return false;
  const end = String.raw`(?![a-z0-9])`;
  return new RegExp(String.raw`\b${CHOOSING}\s+${LEAD_IN}project(?:\s+folder)?(?:\s+(?:called|named))?\s*:?\s*${QUOTE}${n}${end}`).test(words)
    || new RegExp(String.raw`\b${CHOOSING}\s+${LEAD_IN}${QUOTE}${n}${QUOTE}\s+(?:project|folder)\b`).test(words);
}

/** A folder name typed as it is ("working in hologram_tower") is a choice without the word project. */
function choosesFolderAsTyped(words: string, folder: string): boolean {
  if (!/[_-]/.test(folder)) return false;
  return new RegExp(String.raw`\b${CHOOSING}\s+${LEAD_IN}${QUOTE}${escape(folder.toLowerCase())}(?![a-z0-9_-])`).test(words);
}

/**
 * The project Donny's message chooses, or null. A name that only comes up ("drive the truck over",
 * "using FreeCAD", a photo's uploads/ path) chooses nothing. When several match, the longest name wins
 * ("campfire genesis project" is campfire_genesis, not campfire), then one assigned to this Choom.
 */
export function chosenProject<P extends Project>(message: string, projects: P[], choomName = ''): P | null {
  const words = ownWords(message);
  const chosen = projects.filter(p => !NEVER_PINNED.has(p.folder.toLowerCase()) && (
    choosesName(words, p.folder)
    || (!!p.metadata.name && choosesName(words, p.metadata.name))
    || choosesFolderAsTyped(words, p.folder)
  ));
  const mine = (p: P) => (p.metadata.assignedChoom || '').toLowerCase() === choomName.toLowerCase() ? 1 : 0;
  chosen.sort((a, b) => (b.folder.length - a.folder.length) || (mine(b) - mine(a)));
  return chosen[0] ?? null;
}

/** Whether Donny's message asks her to create a project ("create a project called X", "start a new project"). */
export function asksForNewProject(message: string): boolean {
  const words = ownWords(message);
  return new RegExp(String.raw`\b${CREATING}\s+${LEAD_IN}project\b`).test(words) || /\bnew\s+project\b/.test(words);
}

/** Pins the project to the chat; the chat page's menu ("Working in") reads it from there. */
export async function pinChatProject(chatId: string, folder: string): Promise<void> {
  await prisma.chat.update({ where: { id: chatId }, data: { activeProjectFolder: folder } });
}

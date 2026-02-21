import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import type { ToolCall, ToolResult } from '@/lib/types';
import { getGoogleClient } from '@/lib/google-client';

const TASK_TOOLS = new Set([
  'list_task_lists',
  'get_task_list',
  'add_to_task_list',
  'remove_from_task_list',
]);

export default class GoogleTasksHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return TASK_TOOLS.has(toolName);
  }

  async execute(toolCall: ToolCall, ctx: SkillHandlerContext): Promise<ToolResult> {
    switch (toolCall.name) {
      case 'list_task_lists':
        return this.listTaskLists(toolCall);
      case 'get_task_list':
        return this.getTaskList(toolCall);
      case 'add_to_task_list':
        return this.addToTaskList(toolCall);
      case 'remove_from_task_list':
        return this.removeFromTaskList(toolCall);
      default:
        return this.error(toolCall, `Unknown task tool: ${toolCall.name}`);
    }
  }

  private async listTaskLists(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const googleClient = getGoogleClient();
      const lists = await googleClient.getTaskLists();
      const formatted = lists.length === 0
        ? 'No task lists found.'
        : lists.map(l => `- ${l.title}`).join('\n');

      console.log(`   📋 Task Lists: ${lists.length} lists found`);

      return this.success(toolCall, { success: true, lists: lists.map(l => l.title), formatted, count: lists.length });
    } catch (listError) {
      console.error('   ❌ List task lists error:', listError instanceof Error ? listError.message : listError);
      return this.error(toolCall, `Failed to list task lists: ${listError instanceof Error ? listError.message : 'Unknown error'}`);
    }
  }

  private async getTaskList(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const listName = toolCall.arguments.list_name as string;
      const googleClient = getGoogleClient();
      const tasks = await googleClient.getTasksByListName(listName);

      const formatted = tasks.length === 0
        ? `No items on the "${listName}" list.`
        : tasks.map(t => `- ${t.title}${t.notes ? ` (${t.notes})` : ''}`).join('\n');

      console.log(`   📋 Tasks: ${tasks.length} items in "${listName}"`);

      return this.success(toolCall, { success: true, tasks, formatted, count: tasks.length, listName });
    } catch (taskError) {
      console.error('   ❌ Tasks error:', taskError instanceof Error ? taskError.message : taskError);
      return this.error(toolCall, `Task list fetch failed: ${taskError instanceof Error ? taskError.message : 'Unknown error'}`);
    }
  }

  private async addToTaskList(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const listName = toolCall.arguments.list_name as string;
      const itemTitle = toolCall.arguments.item_title as string;
      const notes = toolCall.arguments.notes as string | undefined;
      const googleClient = getGoogleClient();
      const task = await googleClient.addTaskToListName(listName, itemTitle, notes);

      console.log(`   ✅ Added "${itemTitle}" to "${listName}"`);

      return this.success(toolCall, { success: true, task, message: `Added "${itemTitle}" to ${listName} list.` });
    } catch (addError) {
      console.error('   ❌ Add task error:', addError instanceof Error ? addError.message : addError);
      return this.error(toolCall, `Failed to add task: ${addError instanceof Error ? addError.message : 'Unknown error'}`);
    }
  }

  private async removeFromTaskList(toolCall: ToolCall): Promise<ToolResult> {
    try {
      const listName = toolCall.arguments.list_name as string;
      const itemTitle = toolCall.arguments.item_title as string;
      const googleClient = getGoogleClient();
      await googleClient.removeTaskFromListName(listName, itemTitle);

      console.log(`   🗑️ Removed "${itemTitle}" from "${listName}"`);

      return this.success(toolCall, { success: true, message: `Removed "${itemTitle}" from ${listName} list.` });
    } catch (removeError) {
      console.error('   ❌ Remove task error:', removeError instanceof Error ? removeError.message : removeError);
      return this.error(toolCall, `Failed to remove task: ${removeError instanceof Error ? removeError.message : 'Unknown error'}`);
    }
  }
}

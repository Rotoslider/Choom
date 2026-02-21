import { BaseSkillHandler, SkillHandlerContext } from '@/lib/skill-handler';
import { ToolCall, ToolResult } from '@/lib/types';
import { getGoogleClient } from '@/lib/google-client';

const SHEETS_TOOLS = new Set([
  'list_spreadsheets',
  'create_spreadsheet',
  'read_sheet',
  'write_sheet',
  'append_to_sheet',
]);

export default class GoogleSheetsHandler extends BaseSkillHandler {
  canHandle(toolName: string): boolean {
    return SHEETS_TOOLS.has(toolName);
  }

  async execute(toolCall: ToolCall, _ctx: SkillHandlerContext): Promise<ToolResult> {
    try {
      const googleClient = getGoogleClient();

      switch (toolCall.name) {
        case 'list_spreadsheets': {
          const maxResults = (toolCall.arguments.max_results as number) || 20;
          const spreadsheets = await googleClient.listSpreadsheets(maxResults);

          const formatted = spreadsheets.length === 0
            ? 'No spreadsheets found.'
            : spreadsheets.map((s) => `- ${s.name} (${s.url})`).join('\n');

          console.log(`   [sheets] Spreadsheets: ${spreadsheets.length} found`);

          return this.success(toolCall, { success: true, spreadsheets, formatted, count: spreadsheets.length });
        }

        case 'create_spreadsheet': {
          const title = toolCall.arguments.title as string;
          const sheetNames = toolCall.arguments.sheet_names as string[] | undefined;
          const initialData = toolCall.arguments.initial_data as string[][] | undefined;
          const result = await googleClient.createSpreadsheet(title, sheetNames, initialData);

          console.log(`   [sheets] Created spreadsheet: "${title}" (${result.id})`);

          return this.success(toolCall, {
            success: true,
            spreadsheet: result,
            message: `Created spreadsheet "${title}". URL: ${result.url}. Tab names: [${(result.sheetNames || ['Sheet1']).join(', ')}]. IMPORTANT: Use these exact tab names (not "Sheet1") when reading/writing this spreadsheet.`,
          });
        }

        case 'read_sheet': {
          const spreadsheetId = toolCall.arguments.spreadsheet_id as string;
          const range = toolCall.arguments.range as string;
          console.log(`   [sheets] read_sheet: id="${spreadsheetId}", range="${range}"`);
          const result = await googleClient.readSheet(spreadsheetId, range);

          const formatted = result.values.length === 0
            ? 'No data in that range.'
            : result.values.map((row: string[]) => row.join('\t')).join('\n');

          console.log(`   [sheets] Read ${result.values.length} rows from ${spreadsheetId}`);

          return this.success(toolCall, { success: true, ...result, formatted, rowCount: result.values.length });
        }

        case 'write_sheet': {
          const spreadsheetId = toolCall.arguments.spreadsheet_id as string;
          const range = toolCall.arguments.range as string;
          const values = toolCall.arguments.values;
          console.log(`   [sheets] write_sheet: id="${spreadsheetId}", range="${range}"`);
          const result = await googleClient.writeSheet(spreadsheetId, range, values);

          console.log(`   [sheets] Wrote ${result.updatedRows} rows to ${spreadsheetId}`);

          return this.success(toolCall, {
            success: true,
            ...result,
            message: `Wrote ${result.updatedCells} cells to ${result.updatedRange}.`,
          });
        }

        case 'append_to_sheet': {
          const spreadsheetId = toolCall.arguments.spreadsheet_id as string;
          const range = toolCall.arguments.range as string;
          const values = toolCall.arguments.values;
          console.log(`   [sheets] append_to_sheet: id="${spreadsheetId}", range="${range}"`);
          const result = await googleClient.appendToSheet(spreadsheetId, range, values);

          console.log(`   [sheets] Appended ${result.updatedRows} rows to ${spreadsheetId}`);

          return this.success(toolCall, {
            success: true,
            ...result,
            message: `Appended ${result.updatedRows} rows.`,
          });
        }

        default:
          return this.error(toolCall, `Unknown tool: ${toolCall.name}`);
      }
    } catch (err) {
      return this.error(
        toolCall,
        `Failed ${toolCall.name}: ${err instanceof Error ? err.message : 'Unknown error'}`
      );
    }
  }
}

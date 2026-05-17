import { z } from "zod";
import { FileOperationResult } from "../../types.js";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ensureMarkdownExtension, validateVaultPath } from "../../utils/path.js";
import { fileExists } from "../../utils/files.js";
import { createNoteNotFoundError, handleFsError } from "../../utils/errors.js";
import { createToolResponse, formatFileResult } from "../../utils/responses.js";
import { createTool } from "../../utils/tool-factory.js";

// Flat schema — no discriminatedUnion so zodToJsonSchema produces a proper object schema
const schema = z.object({
  vault: z.string()
    .min(1, "Vault name cannot be empty")
    .describe("Name of the vault containing the note"),
  filename: z.string()
    .min(1, "Filename cannot be empty")
    .refine(name => !name.includes('/') && !name.includes('\\'),
      "Filename cannot contain path separators - use the 'folder' parameter for paths instead")
    .describe("Just the note name without any path separators (e.g. 'my-note.md', NOT 'folder/my-note.md')"),
  folder: z.string()
    .optional()
    .refine(folder => !folder || !path.isAbsolute(folder),
      "Folder must be a relative path")
    .describe("Optional subfolder path relative to vault root"),
  operation: z.enum(['append', 'prepend', 'replace'])
    .describe("Type of edit operation - must be one of: 'append', 'prepend', 'replace'"),
  content: z.string()
    .min(1, "Content cannot be empty")
    .describe("Content to add/prepend/replace")
}).strict();

type EditNoteArgs = z.infer<typeof schema>;
type EditOperation = EditNoteArgs['operation'];

async function editNote(
  vaultPath: string,
  filename: string,
  operation: EditOperation,
  content: string,
  folder?: string
): Promise<FileOperationResult> {
  const sanitizedFilename = ensureMarkdownExtension(filename);
  const fullPath = folder
    ? path.join(vaultPath, folder, sanitizedFilename)
    : path.join(vaultPath, sanitizedFilename);

  validateVaultPath(vaultPath, fullPath);

  const timestamp = Date.now();
  const backupPath = `${fullPath}.${timestamp}.backup`;

  try {
    if (!await fileExists(fullPath)) {
      throw createNoteNotFoundError(filename);
    }

    await fs.copyFile(fullPath, backupPath);

    try {
      const existingContent = await fs.readFile(fullPath, "utf-8");

      let newContent: string;
      if (operation === 'append') {
        newContent = existingContent.trim() + (existingContent.trim() ? '\n\n' : '') + content;
      } else if (operation === 'prepend') {
        newContent = content + (existingContent.trim() ? '\n\n' : '') + existingContent.trim();
      } else {
        newContent = content;
      }

      await fs.writeFile(fullPath, newContent);
      await fs.unlink(backupPath);

      return {
        success: true,
        message: `Note ${operation}ed successfully`,
        path: fullPath,
        operation: 'edit'
      };
    } catch (error: unknown) {
      if (await fileExists(backupPath)) {
        try {
          await fs.copyFile(backupPath, fullPath);
          await fs.unlink(backupPath);
        } catch (rollbackError: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const rollbackErrorMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to rollback changes. Original error: ${errorMessage}. Rollback error: ${rollbackErrorMessage}. Backup file preserved at ${backupPath}`
          );
        }
      }
      throw error;
    }
  } catch (error: unknown) {
    if (await fileExists(backupPath)) {
      try {
        await fs.copyFile(backupPath, fullPath);
        await fs.unlink(backupPath);
      } catch (rollbackError: unknown) {
        const rollbackErrorMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        console.error('Failed to cleanup/restore backup during error handling:', rollbackErrorMessage);
      }
    }
    if (error instanceof McpError) {
      throw error;
    }
    throw handleFsError(error, `${operation} note`);
  }
}

export function createEditNoteTool(vaults: Map<string, string>) {
  return createTool<EditNoteArgs>({
    name: "edit-note",
    description: `Edit an existing note in the specified vault.

    There is a limited and discrete list of supported operations:
    - append: Appends content to the end of the note
    - prepend: Prepends content to the beginning of the note
    - replace: Replaces the entire content of the note

Examples:
- Root note: { "vault": "vault1", "filename": "note.md", "operation": "append", "content": "new content" }
- Subfolder note: { "vault": "vault2", "filename": "note.md", "folder": "journal/2024", "operation": "append", "content": "new content" }
- INCORRECT: { "filename": "journal/2024/note.md" } (don't put path in filename)`,
    schema,
    handler: async (args, vaultPath, _vaultName) => {
      const result = await editNote(
        vaultPath,
        args.filename,
        args.operation,
        args.content,
        args.folder
      );
      return createToolResponse(formatFileResult(result));
    }
  }, vaults);
}

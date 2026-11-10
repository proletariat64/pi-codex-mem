import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryVersion } from "../config.ts";
import { readWorkspaceUtf8, safeWorkspacePath } from "../pipeline/workspace-tools.ts";
import type { EvidenceAccess, EvidenceOperation } from "./evidence.ts";
import type { MemoryEvidenceReader } from "./tools.ts";

interface SavedNote {
  note_id: string; text_path: string; text_hash: string; scope: string;
  action: "remember" | "correct"; created_at: number;
}

/** Saved user evidence is readable without a generated publication or foreground carrier. */
export function savedNotesReader(input: {
  root: string; db: DatabaseSync; memoryVersion: MemoryVersion;
}): MemoryEvidenceReader {
  const { root, db, memoryVersion } = input;
  // SAFETY: the initialized notes schema constrains the selected columns and action values.
  const rows = () => db.prepare(`SELECT note_id, text_path, text_hash, scope, action, created_at
    FROM notes WHERE status = 'active' ORDER BY created_at, note_id`).all() as unknown as SavedNote[];
  const notes = rows();
  const epoch = () => db.prepare("SELECT control_epoch FROM store_state WHERE singleton = 1").get()?.control_epoch;
  const controlEpoch = epoch();
  const revision = JSON.stringify(notes);
  // Existing monotonic creation time and revocation epoch fence pagination; no new fingerprint policy.
  const generationId = `saved-notes:${controlEpoch}:${notes.at(-1)?.created_at ?? 0}:${notes.length}`;
  const byPath = new Map(notes.map(note => [`notes/${note.note_id}.md`, note]));
  const validate = () => {
    if (epoch() !== controlEpoch || JSON.stringify(rows()) !== revision) throw new Error("saved_notes_changed");
  };
  return {
    memoryVersion, generationId, source: "saved_notes",
    withEvidence<T>(_context: unknown, operation: (access: EvidenceAccess) => EvidenceOperation<T>): T {
      // Fence the synchronous operation once at each boundary; each read below
      // still checks its file's path, type, size and content hash.
      validate();
      const normalizePath = (value: unknown): string => {
        if (typeof value !== "string" || value.includes("\\") || value.includes("\0") ||
            value.split("/").includes("..")) throw new Error("path_not_available_for_version");
        const path = value.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "") || ".";
        if (path !== "." && path !== "notes" && !byPath.has(path)) throw new Error("path_not_available_for_version");
        return path;
      };
      const read = (path: string) => {
        const note = byPath.get(path);
        if (!note) throw new Error("path_not_available_for_version");
        if (resolve(note.text_path) !== resolve(root, path)) throw new Error("saved_note_integrity");
        const file = safeWorkspacePath(root, path);
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384 ||
            realpathSync(file) !== resolve(realpathSync(root), path)) {
          throw new Error("saved_note_integrity");
        }
        const text = readWorkspaceUtf8(root, path);
        if (createHash("sha256").update(text).digest("hex") !== note.text_hash) throw new Error("saved_note_integrity");
        return text;
      };
      const access: EvidenceAccess = {
        normalizePath,
        isReadablePath: path => byPath.has(path),
        paths: (prefix = ".") => {
          const path = normalizePath(prefix);
          return [...byPath.keys()].filter(file => path === "." || path === "notes" || file === path);
        },
        read,
        sources: path => byPath.has(path) ? [byPath.get(path)!.note_id] : [],
        attributedLines: path => {
          const lines = read(path).split("\n");
          return { lines, attribution: lines.map(() => [byPath.get(path)!.note_id]) };
        },
        sourceMetadata: ids => {
          const note = notes.find(note => note.note_id === ids[0]);
          return { sourceIds: [...ids], ...(note ? { noteId: note.note_id, scope: note.scope,
            action: note.action, createdAt: note.created_at } : {}) };
        },
      };
      const pending = operation(access);
      validate();
      return pending.complete();
    },
  };
}

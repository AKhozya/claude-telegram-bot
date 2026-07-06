/**
 * Document handler for Claude Telegram Bot.
 *
 * Supports PDFs and text files with media group buffering.
 * PDFs: pdftotext for the text layer, pdftocairo to render image/scanned PDFs
 * to page images for Claude vision (poppler-utils; apk in the container image).
 */

import { readdirSync, lstatSync, unlinkSync } from "fs";
import { join } from "path";
import type { BotContext } from "../types";
import { session } from "../session";
import { ALLOWED_USERS, TEMP_DIR } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import { auditLog, auditLogRateLimit, startTypingIndicator } from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";
import { createMediaGroupBuffer, handleProcessingError } from "./media-group";
import { processPhotos } from "./photo";
import { downloadTelegramFile } from "./download";
import { markReceived, markDone, markFailed } from "./reactions";

// Supported text file extensions
const TEXT_EXTENSIONS = [
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".ts",
  ".py",
  ".sh",
  ".env",
  ".log",
  ".cfg",
  ".ini",
  ".toml",
];

// Supported archive extensions
const ARCHIVE_EXTENSIONS = [".zip", ".tar", ".tar.gz", ".tgz"];

// Max file size (20MB — Telegram getFile ceiling)
const MAX_FILE_SIZE = 20 * 1024 * 1024;

// Max content from archive (50K chars total)
const MAX_ARCHIVE_CONTENT = 50000;

// PDF vision fallback tuning
const PDF_VISION_MAX_PAGES = 10; // cap pages rendered for vision (cost + Telegram)
const PDF_TEXT_MIN_CHARS = 16; // < this many non-whitespace chars ⇒ image PDF

/**
 * True if a PDF's extracted text has real content. Scanned / image /
 * print-to-PDF files yield near-zero non-whitespace chars; those route to the
 * vision path instead. Pure + exported so it's unit-testable without a real PDF.
 * ponytail: absolute floor, not per-page — a mixed doc (text cover + scanned
 * pages) reads as text and Claude only sees the text; send scans on their own.
 */
export function pdfHasUsableText(rawText: string): boolean {
  return rawText.replace(/\s/g, "").length >= PDF_TEXT_MIN_CHARS;
}

/**
 * Extract a PDF's text layer, or null if it has ~no usable text
 * (scanned / print-to-PDF) — caller should render pages to images instead.
 */
async function extractPdfText(filePath: string): Promise<string | null> {
  // timeout: bound pdftotext against XObject/JBIG2 decompression-bomb PDFs.
  const result = await Bun.$`timeout 30 pdftotext -layout ${filePath} -`.quiet();
  // Cap like the plain-text branch (:extractText) — a bomb PDF's text layer can
  // decompress to hundreds of MB within the 20MB file cap.
  const text = result.text().slice(0, 100000);
  return pdfHasUsableText(text) ? text : null;
}

/**
 * Sort pdftocairo page files (page-1.png … page-10.png) by page number.
 * Lexicographic sort would put page-10 before page-2. Pure + exported for test.
 */
export function sortPdfPagePaths(names: string[]): string[] {
  const pageNum = (f: string) => parseInt(f.match(/-(\d+)\.png$/)?.[1] ?? "0", 10);
  return [...names].sort((a, b) => pageNum(a) - pageNum(b));
}

/**
 * Render the first PDF_VISION_MAX_PAGES pages of a PDF to PNGs in a unique temp
 * subdir. Returns the dir and page paths sorted by page number, or [] on failure
 * (dir is deleted on failure). pdftocairo writes page-1.png, page-2.png…
 * (research picked it over pdftoppm: same package, better color via cairo+lcms2).
 * Rendered images on the success path are NOT deleted here — like downloaded
 * photos they must outlive an ask_user pause that resumes the session later.
 */
async function renderPdfToImages(
  filePath: string
): Promise<{ dir: string; images: string[] }> {
  // Random suffix: Date.now() alone collides on concurrent same-ms uploads.
  const dir = `${TEMP_DIR}/pdf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await Bun.$`mkdir -p ${dir}`.quiet();
  try {
    // timeout: bound pdftocairo against huge-MediaBox / decompression-bomb PDFs.
    await Bun.$`timeout 60 pdftocairo -png -r 150 -l ${PDF_VISION_MAX_PAGES} ${filePath} ${dir}/page`.quiet();
    const names = await Array.fromAsync(new Bun.Glob("page*.png").scan({ cwd: dir }));
    if (names.length === 0) throw new Error("pdftocairo produced no pages");
    return { dir, images: sortPdfPagePaths(names).map((n) => `${dir}/${n}`) };
  } catch (error) {
    console.error("PDF render failed:", error);
    await Bun.$`rm -rf ${dir}`.quiet(); // don't leak the temp dir on failure
    return { dir, images: [] };
  }
}

// Create document-specific media group buffer
const documentBuffer = createMediaGroupBuffer({
  emoji: "📄",
  itemLabel: "document",
  itemLabelPlural: "documents",
});

/**
 * Download a document and return the local path.
 */
async function downloadDocument(ctx: BotContext): Promise<string> {
  const doc = ctx.message?.document;
  if (!doc) {
    throw new Error("No document in message");
  }

  const fileName = doc.file_name || `doc_${Date.now()}`;

  // Sanitize filename. "/" → "_" already blocks traversal; also reject a
  // dot-only name (".", "..") which would resolve to TEMP_DIR's parent.
  let safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (/^\.+$/.test(safeName)) safeName = `doc_${Date.now()}`;
  const docPath = `${TEMP_DIR}/${safeName}`;

  return await downloadTelegramFile(ctx, docPath);
}

/**
 * Extract text from a document.
 */
async function extractText(
  filePath: string,
  mimeType?: string
): Promise<string> {
  const fileName = filePath.split("/").pop() || "";
  const extension = "." + (fileName.split(".").pop() || "").toLowerCase();

  // PDF text layer via pdftotext (poppler-utils in the container image).
  // Image/scanned PDFs have no text layer — the single-doc path renders them to
  // images for vision; in an album we can't, so return an honest note.
  if (mimeType === "application/pdf" || extension === ".pdf") {
    const text = await extractPdfText(filePath);
    if (text !== null) return text;
    return "[Image-based PDF — no text layer. Send it on its own for page-image analysis.]";
  }

  // Text files
  if (TEXT_EXTENSIONS.includes(extension) || mimeType?.startsWith("text/")) {
    const text = await Bun.file(filePath).text();
    // Limit to 100K chars
    return text.slice(0, 100000);
  }

  throw new Error(`Unsupported file type: ${extension || mimeType}`);
}

/**
 * Check if a file extension is an archive.
 */
function isArchive(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Get archive extension from filename.
 */
function getArchiveExtension(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".tar.gz")) return ".tar.gz";
  if (lower.endsWith(".tgz")) return ".tgz";
  if (lower.endsWith(".tar")) return ".tar";
  if (lower.endsWith(".zip")) return ".zip";
  return "";
}

/**
 * A member name escapes the extraction dir if it is absolute or walks up via
 * `..` — extracting it would write outside extractDir (zip-slip / tar traversal),
 * which tar/unzip do not reliably block across busybox/bsdtar/Info-ZIP variants.
 */
export function isUnsafeMemberName(name: string): boolean {
  if (name.startsWith("/") || name.startsWith("~")) return true;
  return name.split(/[\\/]/).some((seg) => seg === "..");
}

/**
 * List an archive's member names without extracting, for pre-validation.
 * Zip uses `unzip -Z1` (one raw name per line — not evadable by crafted names the
 * way `-l` column parsing would be). BusyBox's unzip lacks `-Z`, so zip fails closed
 * in the container image (which ships no full unzip); tar works everywhere.
 */
export async function listArchiveMembers(
  archivePath: string,
  ext: string
): Promise<string[]> {
  const out =
    ext === ".zip"
      ? await Bun.$`unzip -Z1 ${archivePath}`.quiet().text()
      : await Bun.$`tar -tf ${archivePath}`.quiet().text();
  return out.split("\n").filter(Boolean);
}

/**
 * Remove link members under `root` (recursively) before any content is read.
 * Both are read-exfil vectors to files outside the extraction dir:
 *   - symlink (`link -> /etc/passwd`): reading it follows the link.
 *   - hard link (tar linkname to an existing host file): extracts as a regular
 *     file sharing the target's inode, so lstat reports isFile/nlink>1 — reading
 *     it returns the target's bytes. protected_hardlinks blocks cross-owner
 *     targets but not files the bot's own uid can read (.env, keys).
 * Deleting the entry (not the inode data) neutralises both. A hard link also drops
 * legit intra-archive dedup, which is fine for text extraction (fail closed).
 */
export function stripLinks(root: string): void {
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    const st = lstatSync(full);
    if (st.isSymbolicLink() || (st.isFile() && st.nlink > 1)) {
      unlinkSync(full);
    } else if (st.isDirectory()) {
      stripLinks(full);
    }
  }
}

/**
 * Extract an archive to a temp directory.
 */
async function extractArchive(
  archivePath: string,
  fileName: string
): Promise<string> {
  const ext = getArchiveExtension(fileName);
  const extractDir = `${TEMP_DIR}/archive_${Date.now()}`;
  await Bun.$`mkdir -p ${extractDir}`;

  // Refuse the whole archive if any member would escape extractDir. Cheaper and
  // more portable than trusting each extractor's traversal handling.
  const members = await listArchiveMembers(archivePath, ext);
  if (members.some(isUnsafeMemberName)) {
    throw new Error("Archive contains unsafe member paths (absolute or ..)");
  }

  if (ext === ".zip") {
    await Bun.$`unzip -q -o ${archivePath} -d ${extractDir}`.quiet();
  } else if (ext === ".tar" || ext === ".tar.gz" || ext === ".tgz") {
    await Bun.$`tar -xf ${archivePath} -C ${extractDir}`.quiet();
  } else {
    throw new Error(`Unknown archive type: ${ext}`);
  }

  // Drop extracted symlink/hard-link members before content is read (containment).
  stripLinks(extractDir);

  return extractDir;
}

/**
 * Build a file tree from a directory.
 */
async function buildFileTree(dir: string): Promise<string[]> {
  const entries = await Array.fromAsync(
    new Bun.Glob("**/*").scan({ cwd: dir, dot: false })
  );
  entries.sort();
  return entries.slice(0, 100); // Limit to 100 files
}

/**
 * Extract text content from archive files.
 */
async function extractArchiveContent(
  extractDir: string
): Promise<{
  tree: string[];
  contents: Array<{ name: string; content: string }>;
}> {
  const tree = await buildFileTree(extractDir);
  const contents: Array<{ name: string; content: string }> = [];
  let totalSize = 0;

  for (const relativePath of tree) {
    const fullPath = join(extractDir, relativePath);
    // lstat (no-follow): only read plain single-link files. Symlinks and hard-link
    // members are already stripped; nlink>1 is a second guard against link exfil.
    let info;
    try {
      info = lstatSync(fullPath);
    } catch {
      continue;
    }
    if (!info.isFile() || info.nlink > 1 || info.size === 0) continue;
    const size = info.size;

    const ext = "." + (relativePath.split(".").pop() || "").toLowerCase();
    if (!TEXT_EXTENSIONS.includes(ext)) continue;

    // Skip large files
    if (size > 100000) continue;

    try {
      const text = await Bun.file(fullPath).text();
      const truncated = text.slice(0, 10000); // 10K per file max
      if (totalSize + truncated.length > MAX_ARCHIVE_CONTENT) break;
      contents.push({ name: relativePath, content: truncated });
      totalSize += truncated.length;
    } catch {
      // Skip binary or unreadable files
    }
  }

  return { tree, contents };
}

/**
 * Process an archive file.
 */
async function processArchive(
  ctx: BotContext,
  archivePath: string,
  fileName: string,
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number
): Promise<void> {
  const stopProcessing = session.startProcessing();
  const typing = startTypingIndicator(ctx);

  // Show extraction progress
  const statusMsg = await ctx.reply(`📦 Extracting <b>${fileName}</b>...`, {
    parse_mode: "HTML",
  });

  try {
    // Extract archive
    console.log(`Extracting archive: ${fileName}`);
    const extractDir = await extractArchive(archivePath, fileName);
    const { tree, contents } = await extractArchiveContent(extractDir);
    console.log(`Extracted: ${tree.length} files, ${contents.length} readable`);

    // Update status
    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      `📦 Extracted <b>${fileName}</b>: ${tree.length} files, ${contents.length} readable`,
      { parse_mode: "HTML" }
    );

    // Build prompt
    const treeStr = tree.length > 0 ? tree.join("\n") : "(empty)";
    const contentsStr =
      contents.length > 0
        ? contents.map((c) => `--- ${c.name} ---\n${c.content}`).join("\n\n")
        : "(no readable text files)";

    const prompt = caption
      ? `Archive: ${fileName}\n\nFile tree (${tree.length} files):\n${treeStr}\n\nExtracted contents:\n${contentsStr}\n\n---\n\n${caption}`
      : `Please analyze this archive (${fileName}):\n\nFile tree (${tree.length} files):\n${treeStr}\n\nExtracted contents:\n${contentsStr}`;

    // Set conversation title (if new session)
    if (!session.isActive) {
      const rawTitle = caption || `[Archivio: ${fileName}]`;
      const title =
        rawTitle.length > 50 ? rawTitle.slice(0, 47) + "..." : rawTitle;
      session.conversationTitle = title;
    }

    // Create streaming state
    const state = new StreamingState();
    const statusCallback = createStatusCallback(ctx, state);

    const response = await session.sendMessageStreaming(
      prompt,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );

    await auditLog(
      userId,
      username,
      "ARCHIVE",
      `[${fileName}] ${caption || ""}`,
      response
    );
    await markDone(ctx);

    // Cleanup
    await Bun.$`rm -rf ${extractDir}`.quiet();

    // Delete status message
    try {
      await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
    } catch {
      // Ignore deletion errors
    }
  } catch (error) {
    console.error("Archive processing error:", error);
    await markFailed(ctx);
    // Delete status message on error
    try {
      await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
    } catch {
      // Ignore
    }
    await ctx.reply(
      `❌ Failed to process archive: ${String(error).slice(0, 100)}`
    );
  } finally {
    stopProcessing();
    typing.stop();
  }
}

/**
 * Process documents with Claude.
 */
async function processDocuments(
  ctx: BotContext,
  documents: Array<{ path: string; name: string; content: string }>,
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number
): Promise<void> {
  // Mark processing started
  const stopProcessing = session.startProcessing();

  // Build prompt
  let prompt: string;
  if (documents.length === 1) {
    const doc = documents[0]!;
    prompt = caption
      ? `Document: ${doc.name}\n\nContent:\n${doc.content}\n\n---\n\n${caption}`
      : `Please analyze this document (${doc.name}):\n\n${doc.content}`;
  } else {
    const docList = documents
      .map((d, i) => `--- Document ${i + 1}: ${d.name} ---\n${d.content}`)
      .join("\n\n");
    prompt = caption
      ? `${documents.length} Documents:\n\n${docList}\n\n---\n\n${caption}`
      : `Please analyze these ${documents.length} documents:\n\n${docList}`;
  }

  // Set conversation title (if new session)
  if (!session.isActive) {
    const docName = documents[0]?.name || "[Documento]";
    const rawTitle = caption || `[Documento: ${docName}]`;
    const title =
      rawTitle.length > 50 ? rawTitle.slice(0, 47) + "..." : rawTitle;
    session.conversationTitle = title;
  }

  // Start typing
  const typing = startTypingIndicator(ctx);

  // Create streaming state
  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);

  try {
    const response = await session.sendMessageStreaming(
      prompt,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );

    await auditLog(
      userId,
      username,
      "DOCUMENT",
      `[${documents.length} docs] ${caption || ""}`,
      response
    );
    await markDone(ctx);
  } catch (error) {
    await handleProcessingError(ctx, error, state.toolMessages);
  } finally {
    stopProcessing();
    typing.stop();
  }
}

/**
 * Process document paths by extracting text and calling processDocuments.
 */
async function processDocumentPaths(
  ctx: BotContext,
  paths: string[],
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number
): Promise<void> {
  // Extract text from all documents
  const documents: Array<{ path: string; name: string; content: string }> = [];

  for (const path of paths) {
    try {
      const name = path.split("/").pop() || "document";
      const content = await extractText(path);
      documents.push({ path, name, content });
    } catch (error) {
      console.error(`Failed to extract ${path}:`, error);
    }
  }

  if (documents.length === 0) {
    await markFailed(ctx);
    await ctx.reply("❌ Failed to extract any documents.");
    return;
  }

  await processDocuments(ctx, documents, caption, userId, username, chatId);
}

/**
 * Handle incoming document messages.
 */
export async function handleDocument(ctx: BotContext): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const doc = ctx.message?.document;
  const mediaGroupId = ctx.message?.media_group_id;

  if (!userId || !chatId || !doc) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }
  await markReceived(ctx);

  // 2. Check file size
  if (doc.file_size && doc.file_size > MAX_FILE_SIZE) {
    await markFailed(ctx);
    await ctx.reply("❌ File too large. Maximum size is 20MB.");
    return;
  }

  // 3. Check file type
  const fileName = doc.file_name || "";
  const extension = "." + (fileName.split(".").pop() || "").toLowerCase();
  const isPdf = doc.mime_type === "application/pdf" || extension === ".pdf";
  const isText =
    TEXT_EXTENSIONS.includes(extension) || doc.mime_type?.startsWith("text/");
  const isArchiveFile = isArchive(fileName);

  if (!isPdf && !isText && !isArchiveFile) {
    await markFailed(ctx);
    await ctx.reply(
      `❌ Unsupported file type: ${extension || doc.mime_type}\n\n` +
        `Supported: PDF, archives (${ARCHIVE_EXTENSIONS.join(
          ", "
        )}), ${TEXT_EXTENSIONS.join(", ")}`
    );
    return;
  }

  // 4. Download document
  let docPath: string;
  try {
    docPath = await downloadDocument(ctx);
  } catch (error) {
    console.error("Failed to download document:", error);
    await markFailed(ctx);
    await ctx.reply("❌ Failed to download document.");
    return;
  }

  // 5. Archive files - process separately (no media group support)
  if (isArchiveFile) {
    console.log(`Received archive: ${fileName} from @${username}`);
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (!allowed) {
      await auditLogRateLimit(userId, username, retryAfter!);
      await ctx.reply(
        `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
      );
      await markFailed(ctx);
      return;
    }

    await processArchive(
      ctx,
      docPath,
      fileName,
      ctx.message?.caption,
      userId,
      username,
      chatId
    );
    return;
  }

  // 6. Single document - process immediately
  if (!mediaGroupId) {
    console.log(`Received document: ${fileName} from @${username}`);
    // Rate limit
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (!allowed) {
      await auditLogRateLimit(userId, username, retryAfter!);
      await ctx.reply(
        `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
      );
      await markFailed(ctx);
      return;
    }

    try {
      if (isPdf) {
        // Text-first; fall back to vision on image/scanned/print PDFs.
        let text: string | null = null;
        try {
          text = await extractPdfText(docPath);
        } catch (error) {
          // pdftotext failed (corrupt/encrypted) — still try rendering pages.
          console.error("pdftotext failed, trying render:", error);
        }

        if (text !== null) {
          await processDocuments(
            ctx,
            [{ path: docPath, name: fileName, content: text }],
            ctx.message?.caption,
            userId,
            username,
            chatId
          );
        } else {
          const { images } = await renderPdfToImages(docPath);
          if (images.length === 0) {
            await markFailed(ctx);
            await ctx.reply(
              "❌ Could not read this PDF (no text layer and rendering failed)."
            );
            return;
          }
          const cap = ctx.message?.caption;
          const pdfCaption = cap
            ? `[PDF: ${fileName}] ${cap}`
            : `[PDF: ${fileName}] Read these page images and analyze the document.`;
          // Not deleted here: like downloaded photos, the images must outlive an
          // ask_user pause that resumes the session later. Ephemeral /tmp reaps them.
          await processPhotos(ctx, images, pdfCaption, userId, username, chatId);
        }
      } else {
        const content = await extractText(docPath, doc.mime_type);
        await processDocuments(
          ctx,
          [{ path: docPath, name: fileName, content }],
          ctx.message?.caption,
          userId,
          username,
          chatId
        );
      }
    } catch (error) {
      console.error("Failed to extract document:", error);
      await markFailed(ctx);
      await ctx.reply(
        `❌ Failed to process document: ${String(error).slice(0, 100)}`
      );
    }
    return;
  }

  // 7. Media group - buffer with timeout
  await documentBuffer.addToGroup(
    mediaGroupId,
    docPath,
    ctx,
    userId,
    username,
    processDocumentPaths
  );
}

import { Clipboard, Toast, showHUD, showToast } from "@raycast/api";
import { runAppleScript } from "@raycast/utils";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { fileTypeFromFile } from "file-type";

const PHOTOS_IMPORT_SCRIPT = `
on run argv
  set imagePath to item 1 of argv
  set imageFile to POSIX file imagePath
  tell application "Photos"
    import {imageFile}
  end tell
end run
`;

const ALLOWED_PHOTO_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "image/heic",
  "image/heif",
  "image/avif",
]);

async function detectPhotoMimeAndExt(fsPath: string): Promise<{ mime: string; ext: string } | undefined> {
  const result = await fileTypeFromFile(fsPath);
  if (result && ALLOWED_PHOTO_MIMES.has(result.mime)) {
    return { mime: result.mime, ext: result.ext };
  }
  return undefined;
}

function extensionMatchesDetected(fsPath: string, detectedExt: string): boolean {
  const e = path.extname(fsPath).toLowerCase().replace(/^\./, "");
  if (!e) {
    return false;
  }
  if (e === detectedExt) {
    return true;
  }
  if ((e === "jpeg" || e === "jpe") && detectedExt === "jpg") {
    return true;
  }
  if (e === "tif" && detectedExt === "tiff") {
    return true;
  }
  return false;
}

/**
 * Photos often rejects imports when the path has no extension (e.g. CleanShot "Image (2056x1329)"),
 * even if the bytes are valid PNG. Copy to a temp path with the detected extension.
 */
function pathForPhotosImport(fsPath: string, detectedExt: string): { importPath: string; staged: boolean } {
  if (extensionMatchesDetected(fsPath, detectedExt)) {
    return { importPath: fsPath, staged: false };
  }
  const staged = path.join(os.tmpdir(), `raycast-add-to-photos-${randomUUID()}.${detectedExt}`);
  fs.copyFileSync(fsPath, staged);
  return { importPath: staged, staged: true };
}

function resolveFilePath(file: string): string {
  if (file.startsWith("file:")) {
    return fileURLToPath(file);
  }
  return file;
}

export default async function main() {
  let fsPath: string;

  try {
    const { file } = await Clipboard.read();
    if (!file?.trim()) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Clipboard has no image file",
        message: "Copy an image file in Finder so the clipboard includes a file path.",
      });
      return;
    }

    try {
      fsPath = resolveFilePath(file.trim());
    } catch {
      await showToast({
        style: Toast.Style.Failure,
        title: "Invalid clipboard path",
        message: "Could not resolve the file URL from the clipboard.",
      });
      return;
    }

    if (!fs.existsSync(fsPath)) {
      await showToast({
        style: Toast.Style.Failure,
        title: "File not found",
        message: "The clipboard file no longer exists at its path.",
      });
      return;
    }

    const st = fs.statSync(fsPath);
    if (!st.isFile()) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Not a photo file",
        message: "Clipboard points to a folder or special file, not an image file.",
      });
      return;
    }

    let detected: { mime: string; ext: string } | undefined;
    try {
      detected = await detectPhotoMimeAndExt(fsPath);
    } catch {
      await showToast({
        style: Toast.Style.Failure,
        title: "Could not read file",
        message: "The file could not be read. Check permissions.",
      });
      return;
    }

    if (!detected) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Not a photo",
        message: "File type is not a supported image (could not match a known image MIME from file contents).",
      });
      return;
    }

    const { importPath, staged } = pathForPhotosImport(fsPath, detected.ext);

    try {
      await runAppleScript(PHOTOS_IMPORT_SCRIPT, [importPath], { timeout: 120_000 });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Photos could not import the image",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    } finally {
      if (staged && fs.existsSync(importPath)) {
        try {
          fs.unlinkSync(importPath);
        } catch {
          /* ignore */
        }
      }
    }

    await showHUD("Added to Photos");
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Clipboard read failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

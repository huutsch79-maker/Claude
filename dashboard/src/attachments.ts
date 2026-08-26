import type { Attachment } from "./types";

export const SUPPORTED_ATTACHMENT_TYPES = "image/png,image/jpeg,image/gif,image/webp,application/pdf";

export function fileToAttachment(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve({ mediaType: file.type, base64Data: result.split(",")[1] ?? "", filename: file.name });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Pulls any pasted images out of a clipboard event — lets a screenshot be
 * attached with a plain paste instead of saving it to a file first, then
 * clicking the attach button, then finding it in a file picker.
 */
export function attachmentsFromClipboard(event: ClipboardEvent): File[] {
  const files: File[] = [];
  for (const item of event.clipboardData?.items ?? []) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

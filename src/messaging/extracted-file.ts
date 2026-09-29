/**
 * Line the Telegram document handler writes before an attachment's extracted
 * text (`channels/telegram.ts`). The fast runner's DENUE guard cuts the
 * inbound text here, because file content is not the user's words. One
 * constant for the producer and the consumer so they cannot drift.
 */
export const EXTRACTED_FILE_MARKER = "--- Contenido extraído del archivo";

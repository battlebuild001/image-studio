import {openDatabase, transactionResult} from './project.js';

/** Remove portable upload receipts atomically, preserving drafts and all stored media. */
export async function clearStoredYouTubeUploadHistory() {
  const db = await openDatabase();let transaction;
  try {transaction = db.transaction(['projects', 'workspaces', 'library'], 'readwrite');}
  catch (cause) {db.close();throw cause;}
  const complete = transactionResult(transaction, db);let removed = 0;
  for (const name of ['projects', 'workspaces', 'library']) {
    const request = transaction.objectStore(name).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;if (!cursor) return;
      try {
        const record = cursor.value, uploads = record?.project?.production?.youtube?.uploads;
        if (Array.isArray(uploads) && uploads.length) {
          removed += uploads.length;
          record.project.production.youtube.uploads = [];
          cursor.update(record);
        }
        cursor.continue();
      } catch {
        // A failure anywhere must roll back updates already queued for other stores.
        try {transaction.abort();} catch {}
      }
    };
  }
  await complete;return removed;
}

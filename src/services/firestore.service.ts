import { Firestore, FieldValue } from '@google-cloud/firestore';
import { SyncState, KnowledgeDocument } from '../types';

const COLLECTION_SYNC_STATE = 'knowledge_sync_state';
const COLLECTION_DOCUMENTS = 'knowledge_documents';

export class FirestoreService {
  private db: Firestore;

  constructor() {
    this.db = new Firestore();
  }

  // ============================================
  // Sync State Management
  // ============================================

  async getSyncState(source: 'notion' | 'slack'): Promise<SyncState | null> {
    const doc = await this.db.collection(COLLECTION_SYNC_STATE).doc(source).get();
    if (!doc.exists) {
      return null;
    }
    return doc.data() as SyncState;
  }

  async updateSyncState(source: 'notion' | 'slack', state: Partial<SyncState>): Promise<void> {
    const docRef = this.db.collection(COLLECTION_SYNC_STATE).doc(source);
    const doc = await docRef.get();
    
    if (doc.exists) {
      await docRef.update(state);
    } else {
      const fullState: SyncState = {
        lastSyncTimestamp: null,
        status: 'idle',
        totalDocuments: 0,
        ...state,
      };
      await docRef.set(fullState);
    }
  }

  async startSync(source: 'notion' | 'slack'): Promise<void> {
    await this.updateSyncState(source, {
      status: 'running',
      lastRunAt: new Date().toISOString(),
    });
  }

  async completeSync(
    source: 'notion' | 'slack',
    lastSyncTimestamp: string,
    totalDocuments: number
  ): Promise<void> {
    const docRef = this.db.collection(COLLECTION_SYNC_STATE).doc(source);
    await docRef.update({
      status: 'completed',
      lastSyncTimestamp,
      totalDocuments,
      lastError: FieldValue.delete(),
    });
  }

  async failSync(source: 'notion' | 'slack', error: string): Promise<void> {
    await this.updateSyncState(source, {
      status: 'failed',
      lastError: error,
    });
  }

  // ============================================
  // Knowledge Document Management
  // ============================================

  getDocumentId(source: 'notion' | 'slack', sourceId: string): string {
    return `${source}_${sourceId}`;
  }

  async getDocument(source: 'notion' | 'slack', sourceId: string): Promise<KnowledgeDocument | null> {
    const docId = this.getDocumentId(source, sourceId);
    const doc = await this.db.collection(COLLECTION_DOCUMENTS).doc(docId).get();
    if (!doc.exists) {
      return null;
    }
    return doc.data() as KnowledgeDocument;
  }

  async saveDocument(document: KnowledgeDocument): Promise<void> {
    const docId = this.getDocumentId(document.sourceType, document.sourceId);
    await this.db.collection(COLLECTION_DOCUMENTS).doc(docId).set({
      ...document,
      updatedAt: new Date().toISOString(),
    });
  }

  async deleteDocument(docId: string): Promise<void> {
    await this.db.collection(COLLECTION_DOCUMENTS).doc(docId).delete();
  }

  async deleteDocumentBySource(source: 'notion' | 'slack', sourceId: string): Promise<void> {
    const docId = this.getDocumentId(source, sourceId);
    await this.db.collection(COLLECTION_DOCUMENTS).doc(docId).delete();
  }

  async updateDocumentFileId(
    source: 'notion' | 'slack',
    sourceId: string,
    vectorStoreFileId: string
  ): Promise<void> {
    const docId = this.getDocumentId(source, sourceId);
    await this.db.collection(COLLECTION_DOCUMENTS).doc(docId).update({
      vectorStoreFileId,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Get all document IDs for a source (for diff detection)
   */
  async getDocumentIdMap(source: 'notion' | 'slack'): Promise<Map<string, KnowledgeDocument>> {
    const docs = await this.getDocumentsBySource(source);
    return new Map(docs.map(d => [d.sourceId, d]));
  }

  async getDocumentsBySource(source: 'notion' | 'slack'): Promise<KnowledgeDocument[]> {
    const snapshot = await this.db
      .collection(COLLECTION_DOCUMENTS)
      .where('sourceType', '==', source)
      .get();
    
    return snapshot.docs.map(doc => doc.data() as KnowledgeDocument);
  }

  async getDocumentCount(source?: 'notion' | 'slack'): Promise<number> {
    let query = this.db.collection(COLLECTION_DOCUMENTS);
    
    if (source) {
      const snapshot = await query.where('sourceType', '==', source).count().get();
      return snapshot.data().count;
    }
    
    const snapshot = await query.count().get();
    return snapshot.data().count;
  }

  // ============================================
  // Batch Operations
  // ============================================

  async batchSaveDocuments(documents: KnowledgeDocument[]): Promise<void> {
    const batch = this.db.batch();
    const now = new Date().toISOString();

    for (const document of documents) {
      const docId = this.getDocumentId(document.sourceType, document.sourceId);
      const docRef = this.db.collection(COLLECTION_DOCUMENTS).doc(docId);
      batch.set(docRef, {
        ...document,
        updatedAt: now,
      });
    }

    await batch.commit();
  }

  // ============================================
  // Status Retrieval
  // ============================================

  async getAllSyncStatus(): Promise<{
    notion: SyncState | null;
    slack: SyncState | null;
    totalDocuments: number;
  }> {
    const [notion, slack, totalDocuments] = await Promise.all([
      this.getSyncState('notion'),
      this.getSyncState('slack'),
      this.getDocumentCount(),
    ]);

    return { notion, slack, totalDocuments };
  }
}



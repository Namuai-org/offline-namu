import {Platform} from 'react-native';
import type {ExportLabels, ExportService} from '../../domain/model/services';
import NativeNamuExport from './specs/NativeNamuExport';

/**
 * Typed adapter over the NamuExport TurboModule. The database directory is
 * supplied by the composition root so screens never see a native path
 * (ARC-001).
 */
export class NativeExportService implements ExportService {
  constructor(private readonly chatDataDirectory: string) {}

  exportConversation(conversationId: string, labels: ExportLabels): Promise<string> {
    return NativeNamuExport.exportConversation(this.chatDataDirectory, conversationId, JSON.stringify(labels));
  }
  exportAll(labels: ExportLabels): Promise<string> {
    return NativeNamuExport.exportAllConversations(this.chatDataDirectory, JSON.stringify(labels));
  }
  share(exportId: string): Promise<boolean> {
    return NativeNamuExport.share(exportId);
  }
  deleteExport(exportId: string): Promise<void> {
    return NativeNamuExport.deleteExport(exportId);
  }
  async cleanupAfterShare(exportId: string, handedOver: boolean): Promise<void> {
    if (!handedOver || Platform.OS === 'ios') {
      await NativeNamuExport.deleteExport(exportId);
    }
  }
  sweep(): Promise<number> {
    return NativeNamuExport.sweepExports();
  }
  deleteAll(): Promise<void> {
    return NativeNamuExport.deleteAllExports();
  }
}

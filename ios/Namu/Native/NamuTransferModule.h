#import <NamuNativeSpec/NamuNativeSpec.h>

/// TurboModule `NamuTransfer` (contract §3–§6). Thin shim over TransferService,
/// which keeps running when no JS runtime exists (ARC-003).
@interface NamuTransferModule : NativeNamuTransferSpecBase <NativeNamuTransferSpec>
@end

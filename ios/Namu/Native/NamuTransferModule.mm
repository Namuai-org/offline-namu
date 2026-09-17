#import "NamuTransferModule.h"

#import <React/RCTInvalidating.h>

#import "NamuModuleSupport.h"
#import "NamuSwiftBridge.h"

@interface NamuTransferModule () <RCTInvalidating>
@end

@implementation NamuTransferModule {
  NSString *_listenerToken;
  BOOL _canEmit;
}

RCT_EXPORT_MODULE(NamuTransfer)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeNamuTransferSpecJSI>(params);
}

// The JS event emitter exists only after this call; snapshots produced while
// no JS runtime is alive stay in the native journal (ARC-003).
- (void)setEventEmitterCallback:(EventEmitterCallbackWrapper *)eventEmitterCallbackWrapper
{
  [super setEventEmitterCallback:eventEmitterCallbackWrapper];
  @synchronized(self) {
    _canEmit = YES;
    if (_listenerToken == nil) {
      __weak NamuTransferModule *weakSelf = self;
      _listenerToken = [NamuTransferBridge addSnapshotListener:^(NSString *json) {
        [weakSelf emitSnapshot:json];
      }];
    }
  }
}

- (void)emitSnapshot:(NSString *)json
{
  @synchronized(self) {
    if (_canEmit) {
      [self emitOnSnapshot:@{@"json" : json}];
    }
  }
}

- (void)invalidate
{
  @synchronized(self) {
    _canEmit = NO;
    if (_listenerToken != nil) {
      [NamuTransferBridge removeSnapshotListener:_listenerToken];
      _listenerToken = nil;
    }
  }
}

- (void)snapshot:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [NamuTransferBridge snapshot:^(NSString *value, NSString *code, NSString *message) {
    NamuSettleString(value, code, message, resolve, reject);
  }];
}

- (void)getBundledDescriptorSummary:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [NamuTransferBridge bundledDescriptorSummary:^(NSString *value, NSString *code, NSString *message) {
    NamuSettleString(value, code, message, resolve, reject);
  }];
}

- (void)start:(NSString *)source
 allowMetered:(BOOL)allowMetered
      resolve:(RCTPromiseResolveBlock)resolve
       reject:(RCTPromiseRejectBlock)reject
{
  [NamuTransferBridge startWithSource:source
                         allowMetered:allowMetered
                             callback:^(NSString *value, NSString *code, NSString *message) {
                               NamuSettleString(value, code, message, resolve, reject);
                             }];
}

- (void)pause:(NSString *)transferId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [NamuTransferBridge pauseWithTransferId:transferId
                                 callback:^(NSString *value, NSString *code, NSString *message) {
                                   NamuSettleVoid(code, message, resolve, reject);
                                 }];
}

- (void)resume:(NSString *)transferId
  allowMetered:(BOOL)allowMetered
       resolve:(RCTPromiseResolveBlock)resolve
        reject:(RCTPromiseRejectBlock)reject
{
  [NamuTransferBridge resumeWithTransferId:transferId
                              allowMetered:allowMetered
                                  callback:^(NSString *value, NSString *code, NSString *message) {
                                    NamuSettleVoid(code, message, resolve, reject);
                                  }];
}

- (void)cancel:(NSString *)transferId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [NamuTransferBridge cancelWithTransferId:transferId
                                  callback:^(NSString *value, NSString *code, NSString *message) {
                                    NamuSettleVoid(code, message, resolve, reject);
                                  }];
}

- (void)checkForUpdate:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [NamuTransferBridge checkForUpdate:^(NSString *value, NSString *code, NSString *message) {
    NamuSettleString(value, code, message, resolve, reject);
  }];
}

- (void)beginSelfTest:(NSString *)transferId
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
  [NamuTransferBridge beginSelfTestWithTransferId:transferId
                                         callback:^(NSString *value, NSString *code, NSString *message) {
                                           NamuSettleString(value, code, message, resolve, reject);
                                         }];
}

- (void)activate:(NSString *)transferId
  selfTestPassed:(BOOL)selfTestPassed
     failureCode:(NSString *)failureCode
         resolve:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject
{
  [NamuTransferBridge activateWithTransferId:transferId
                              selfTestPassed:selfTestPassed
                                 failureCode:failureCode ?: @""
                                    callback:^(NSString *value, NSString *code, NSString *message) {
                                      NamuSettleString(value, code, message, resolve, reject);
                                    }];
}

- (void)resolveArtifactPath:(NSString *)artifactId
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
  [NamuTransferBridge resolveArtifactPath:artifactId
                                 callback:^(NSString *value, NSString *code, NSString *message) {
                                   NamuSettleString(value, code, message, resolve, reject);
                                 }];
}

- (void)setRuntimeReference:(NSString *)artifactId
{
  [NamuTransferBridge setRuntimeReference:artifactId ?: @""];
}

- (void)noteSuccessfulForegroundSession:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [NamuTransferBridge noteSuccessfulForegroundSession:^(NSString *value, NSString *code, NSString *message) {
    NamuSettleVoid(code, message, resolve, reject);
  }];
}

- (void)restorePrevious:(BOOL)markAbandonedBad
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  [NamuTransferBridge restorePreviousWithMarkAbandonedBad:markAbandonedBad
                                                 callback:^(NSString *value, NSString *code, NSString *message) {
                                                   NamuSettleString(value, code, message, resolve, reject);
                                                 }];
}

- (void)repair:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [NamuTransferBridge repair:^(NSString *value, NSString *code, NSString *message) {
    NamuSettleString(value, code, message, resolve, reject);
  }];
}

- (void)removeModel:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [NamuTransferBridge removeModel:^(NSString *value, NSString *code, NSString *message) {
    NamuSettleVoid(code, message, resolve, reject);
  }];
}

- (void)deleteAllTransferData:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [NamuTransferBridge deleteAllTransferData:^(NSString *value, NSString *code, NSString *message) {
    NamuSettleVoid(code, message, resolve, reject);
  }];
}

@end

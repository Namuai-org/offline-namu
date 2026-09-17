#import "NamuExportModule.h"


#import "NamuModuleSupport.h"
#import "NamuSwiftBridge.h"

@implementation NamuExportModule

RCT_EXPORT_MODULE(NamuExport)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeNamuExportSpecJSI>(params);
}

- (void)exportConversation:(NSString *)dbDirectory
            conversationId:(NSString *)conversationId
                labelsJson:(NSString *)labelsJson
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
  [NamuExportBridge exportConversationWithDbDirectory:dbDirectory
                                       conversationId:conversationId
                                           labelsJson:labelsJson
                                             callback:^(NSString *value, NSString *code, NSString *message) {
                                               NamuSettleString(value, code, message, resolve, reject);
                                             }];
}

- (void)exportAllConversations:(NSString *)dbDirectory
                    labelsJson:(NSString *)labelsJson
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
  [NamuExportBridge exportAllConversationsWithDbDirectory:dbDirectory
                                               labelsJson:labelsJson
                                                 callback:^(NSString *value, NSString *code, NSString *message) {
                                                   NamuSettleString(value, code, message, resolve, reject);
                                                 }];
}

- (void)share:(NSString *)exportId resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [NamuExportBridge share:exportId
                 callback:^(NSNumber *value, NSString *code, NSString *message) {
                   NamuSettleNumber(value, code, message, resolve, reject);
                 }];
}

- (void)deleteExport:(NSString *)exportId
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  [NamuExportBridge deleteExport:exportId
                        callback:^(NSString *value, NSString *code, NSString *message) {
                          NamuSettleVoid(code, message, resolve, reject);
                        }];
}

- (void)sweepExports:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [NamuExportBridge sweepExports:^(NSNumber *value, NSString *code, NSString *message) {
    NamuSettleNumber(value, code, message, resolve, reject);
  }];
}

- (void)deleteAllExports:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [NamuExportBridge deleteAllExports:^(NSString *value, NSString *code, NSString *message) {
    NamuSettleVoid(code, message, resolve, reject);
  }];
}

@end

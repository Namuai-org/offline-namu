#import "NamuPlatformModule.h"

#import <React/RCTInvalidating.h>

#import "NamuModuleSupport.h"
#import "NamuSwiftBridge.h"

@interface NamuPlatformModule () <RCTInvalidating>
@end

@implementation NamuPlatformModule {
  NSString *_thermalToken;
  NSString *_memoryToken;
  NSString *_shortcutToken;
  BOOL _canEmit;
}

RCT_EXPORT_MODULE(NamuPlatform)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeNamuPlatformSpecJSI>(params);
}

// INF-007: events are emitted from the module, never from a view, so they
// reach the controller while no React screen is mounted.
- (void)setEventEmitterCallback:(EventEmitterCallbackWrapper *)eventEmitterCallbackWrapper
{
  [super setEventEmitterCallback:eventEmitterCallbackWrapper];
  @synchronized(self) {
    _canEmit = YES;
    if (_thermalToken == nil) {
      __weak NamuPlatformModule *weakSelf = self;
      _thermalToken = [NamuPlatformBridge addThermalListener:^(NSString *state) {
        [weakSelf emitThermal:state];
      }];
      _memoryToken = [NamuPlatformBridge addMemoryListener:^(NSString *level) {
        [weakSelf emitMemory:level];
      }];
      _shortcutToken = [NamuPlatformBridge addSendShortcutListener:^(NSString *source) {
        [weakSelf emitSendShortcut:source];
      }];
    }
  }
}

- (void)emitThermal:(NSString *)state
{
  @synchronized(self) {
    if (_canEmit) {
      [self emitOnThermalStateChanged:@{@"state" : state}];
    }
  }
}

- (void)emitMemory:(NSString *)level
{
  @synchronized(self) {
    if (_canEmit) {
      [self emitOnMemoryPressure:@{@"level" : level}];
    }
  }
}

// A11Y-002: Cmd+Return on a hardware keyboard.
- (void)emitSendShortcut:(NSString *)source
{
  @synchronized(self) {
    if (_canEmit) {
      [self emitOnSendShortcut:@{@"source" : source}];
    }
  }
}

- (void)invalidate
{
  @synchronized(self) {
    _canEmit = NO;
    if (_shortcutToken != nil) {
      [NamuPlatformBridge removeListener:_shortcutToken];
      _shortcutToken = nil;
    }
    if (_thermalToken != nil) {
      [NamuPlatformBridge removeListener:_thermalToken];
      _thermalToken = nil;
    }
    if (_memoryToken != nil) {
      [NamuPlatformBridge removeListener:_memoryToken];
      _memoryToken = nil;
    }
  }
}

- (facebook::react::ModuleConstants<JS::NativeNamuPlatform::Constants>)getConstants
{
  NSDictionary<NSString *, id> *c = [NamuPlatformBridge constants];
  return facebook::react::typedConstants<JS::NativeNamuPlatform::Constants>({
      .appVersion = c[@"appVersion"] ?: @"",
      .appBuild = [c[@"appBuild"] doubleValue],
      .osName = c[@"osName"] ?: @"iOS",
      .osVersion = c[@"osVersion"] ?: @"",
      .deviceModel = c[@"deviceModel"] ?: @"",
      .isSimulator = (bool)[c[@"isSimulator"] boolValue],
      .isInternalBuild = (bool)[c[@"isInternalBuild"] boolValue],
  });
}

- (facebook::react::ModuleConstants<JS::NativeNamuPlatform::Constants>)constantsToExport
{
  return [self getConstants];
}

- (void)getDeviceProfile:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  resolve([NamuPlatformBridge deviceProfileJSON]);
}

- (NSArray<NSString *> *)getPreferredLocales
{
  return [NamuPlatformBridge preferredLocales];
}

- (NSString *)randomUUID
{
  return [NamuPlatformBridge randomUUID];
}

- (void)getThermalState:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  resolve([NamuPlatformBridge thermalState]);
}

- (void)getAvailableMemoryBytes:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  resolve(@([NamuPlatformBridge availableMemoryBytes]));
}

- (void)prepareChatDataDirectory:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [NamuPlatformBridge prepareChatDataDirectory:^(NSString *value, NSString *code, NSString *message) {
    NamuSettleString(value, code, message, resolve, reject);
  }];
}

- (void)getChatDataSizeBytes:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  resolve(@([NamuPlatformBridge chatDataSizeBytes]));
}

- (void)deleteChatData:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [NamuPlatformBridge deleteChatData:^(NSString *value, NSString *code, NSString *message) {
    NamuSettleVoid(code, message, resolve, reject);
  }];
}

- (void)copyToClipboard:(NSString *)text
{
  [NamuPlatformBridge copyToClipboard:text ?: @""];
}

- (void)haptic:(NSString *)kind
{
  [NamuPlatformBridge haptic:kind ?: @"action"];
}

- (void)isReduceMotionEnabled:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [NamuPlatformBridge isReduceMotionEnabled:^(BOOL enabled) {
    resolve(@(enabled));
  }];
}

@end

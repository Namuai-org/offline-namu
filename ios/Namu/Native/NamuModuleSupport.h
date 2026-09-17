#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

// Shared by the three TurboModule shims: converts the Swift facades'
// (value, errorCode, errorMessage) callbacks into promise settlements.
// Rejections carry the contract's `code` strings (contract §6.5).

NS_INLINE void NamuSettleString(NSString *_Nullable value, NSString *_Nullable code, NSString *_Nullable message,
                                RCTPromiseResolveBlock _Nonnull resolve, RCTPromiseRejectBlock _Nonnull reject)
{
  if (code != nil) {
    reject(code, message.length > 0 ? message : code, nil);
  } else {
    resolve(value ?: @"");
  }
}

NS_INLINE void NamuSettleVoid(NSString *_Nullable code, NSString *_Nullable message,
                              RCTPromiseResolveBlock _Nonnull resolve, RCTPromiseRejectBlock _Nonnull reject)
{
  if (code != nil) {
    reject(code, message.length > 0 ? message : code, nil);
  } else {
    resolve(nil);
  }
}

NS_INLINE void NamuSettleNumber(NSNumber *_Nullable value, NSString *_Nullable code, NSString *_Nullable message,
                                RCTPromiseResolveBlock _Nonnull resolve, RCTPromiseRejectBlock _Nonnull reject)
{
  if (code != nil) {
    reject(code, message.length > 0 ? message : code, nil);
  } else {
    resolve(value ?: @0);
  }
}

// Imports the generated Swift interface (Namu-Swift.h) into Objective-C++.
//
// Objective-C++ sources are compiled without clang modules, so the `@import`
// lines inside Namu-Swift.h are skipped and every Objective-C type the header
// mentions must already be declared. AppDelegate.swift's ReactNativeDelegate
// subclasses RCTDefaultReactNativeFactoryDelegate, hence the import below.
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

#if __has_include(<React-RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h>)
#import <React-RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h>
#elif __has_include(<React_RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h>)
#import <React_RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h>
#else
#import <RCTDefaultReactNativeFactoryDelegate.h>
#endif

#import "Namu-Swift.h"

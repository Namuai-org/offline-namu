#import "NamuGlassView.h"

#import <react/renderer/components/NamuNativeSpec/ComponentDescriptors.h>
#import <react/renderer/components/NamuNativeSpec/Props.h>
#import <react/renderer/components/NamuNativeSpec/RCTComponentViewHelpers.h>

using namespace facebook::react;

/// Leaf view: it hosts no React children, so the effect view can simply fill it.
@implementation NamuGlassView {
  UIVisualEffectView *_effectView;
  NSString *_tone;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
  return concreteComponentDescriptorProvider<NamuGlassViewComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const NamuGlassViewProps>();
    _props = defaultProps;
    _tone = @"light";
    _effectView = [[UIVisualEffectView alloc] initWithEffect:nil];
    _effectView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    _effectView.userInteractionEnabled = NO;
    self.userInteractionEnabled = NO;
    self.clipsToBounds = YES;
    [self addSubview:_effectView];
    [self applyEffect];
  }
  return self;
}

- (void)applyEffect
{
  BOOL dark = [_tone isEqualToString:@"dark"];
  // The tone comes from the Namu theme, which the user may set independently
  // of the OS appearance.
  _effectView.overrideUserInterfaceStyle = dark ? UIUserInterfaceStyleDark : UIUserInterfaceStyleLight;
#if defined(__IPHONE_26_0)
  if (@available(iOS 26.0, *)) {
    UIGlassEffect *glass = [UIGlassEffect effectWithStyle:UIGlassEffectStyleRegular];
    _effectView.effect = glass;
    return;
  }
#endif
  _effectView.effect = [UIBlurEffect effectWithStyle:dark ? UIBlurEffectStyleSystemThinMaterialDark
                                                          : UIBlurEffectStyleSystemThinMaterialLight];
}

- (void)updateProps:(Props::Shared const &)props oldProps:(Props::Shared const &)oldProps
{
  const auto &newProps = *std::static_pointer_cast<const NamuGlassViewProps>(props);
  NSString *tone = [NSString stringWithUTF8String:newProps.tone.c_str()];
  if (tone.length > 0 && ![tone isEqualToString:_tone]) {
    _tone = tone;
    [self applyEffect];
  }
  [super updateProps:props oldProps:oldProps];
}

- (void)layoutSubviews
{
  [super layoutSubviews];
  _effectView.frame = self.bounds;
}

@end

Class<RCTComponentViewProtocol> NamuGlassViewCls(void)
{
  return NamuGlassView.class;
}

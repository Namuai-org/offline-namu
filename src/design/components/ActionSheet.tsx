import React from 'react';
import type {IconName} from '../icons/NamuIcon';
import {NamuDialog} from './NamuDialog';
import {ListRow} from './Rows';

export interface ActionSheetItem {
  key: string;
  label: string;
  icon?: IconName;
  destructive?: boolean;
  selected?: boolean;
  onPress: () => void;
  testID?: string;
}

/**
 * Overflow / choice menu rendered as a dialog list. Every entry pairs its icon
 * with text (DS-003) and has a full-size touch target; focus returns to the
 * opener when it closes (DS-005).
 */
export function ActionSheet({
  visible,
  title,
  items,
  cancelLabel,
  onDismiss,
  returnFocusTo,
}: {
  visible: boolean;
  title: string;
  items: ActionSheetItem[];
  cancelLabel: string;
  onDismiss: () => void;
  returnFocusTo?: React.RefObject<unknown>;
}): React.JSX.Element {
  return (
    <NamuDialog
      visible={visible}
      title={title}
      onDismiss={onDismiss}
      returnFocusTo={returnFocusTo}
      actions={[{label: cancelLabel, onPress: onDismiss}]}>
      {items.map(item => (
        <ListRow
          key={item.key}
          testID={item.testID}
          icon={item.selected ? 'check' : item.icon}
          title={item.label}
          destructive={item.destructive}
          onPress={item.onPress}
          trailing={<></>}
        />
      ))}
    </NamuDialog>
  );
}

import React, {useEffect, useState} from 'react';
import {useServices} from '../../app/ServicesContext';
import {AssistantMessage, type AssistantAction} from '../../design/components/ChatMessage';

/**
 * CHAT-002: the streamed text lives in this component's state, fed by the
 * controller's 50 ms coalesced publications. Only this component re-renders
 * while tokens arrive; the list and the rest of the screen do not.
 */
export function ActiveAnswer({
  attemptId,
  initialText,
  statusLabel,
  actions,
  onLinkPress,
}: {
  attemptId: string;
  initialText: string;
  statusLabel: string;
  actions: AssistantAction[];
  onLinkPress: (href: string, hostname: string) => void;
}): React.JSX.Element {
  const {chat} = useServices();
  const [text, setText] = useState(() => chat.currentStreamText(attemptId) ?? initialText);

  useEffect(() => {
    return chat.subscribeStream(snapshot => {
      if (snapshot.attemptId === attemptId) {
        setText(snapshot.text);
      }
    });
  }, [attemptId, chat]);

  return (
    <AssistantMessage
      testID="active-answer"
      text={text}
      streaming
      statusLabel={statusLabel}
      actions={actions}
      onLinkPress={onLinkPress}
    />
  );
}

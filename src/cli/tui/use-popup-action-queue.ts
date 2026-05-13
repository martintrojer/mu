// Consume App-level PopupAction events one per render.
//
// Mouse double-clicks may need to emit multiple logical popup actions
// in order (setCursor → drill). Processing the whole queue in one
// React effect would make the drill handler see the pre-setCursor
// render's focused row. This hook intentionally dispatches only the
// next unseen action, stores its sequence in state, and lets React
// render the cursor update before dispatching the following action.

import { useEffect, useRef, useState } from "react";
import type { PopupAction, PopupActionEnvelope } from "./keys.js";

export function usePopupActionQueue(
  actions: readonly PopupActionEnvelope[] | undefined,
  dispatch: (action: PopupAction) => void,
): void {
  const [lastSeq, setLastSeq] = useState(0);
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  useEffect(() => {
    const next = actions?.find((event) => event.seq > lastSeq);
    if (next === undefined) return;
    setLastSeq(next.seq);
    dispatchRef.current(next.action);
  }, [actions, lastSeq]);
}

import { EventEmitter } from "node:events";
import type { ZoneStructuredProgressEvent } from "../core/agentLifecycleEvents.js";

export type EventBusEventType = ZoneStructuredProgressEvent["type"];

export interface EventBus {
  emit(type: EventBusEventType, event: ZoneStructuredProgressEvent): void;
  on(type: EventBusEventType, handler: (event: ZoneStructuredProgressEvent) => void): void;
  off(type: EventBusEventType, handler: (event: ZoneStructuredProgressEvent) => void): void;
}

export function createEventBus(): EventBus {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  return {
    emit(type, event) {
      emitter.emit(type, event);
    },
    on(type, handler) {
      emitter.on(type, handler);
    },
    off(type, handler) {
      emitter.off(type, handler);
    },
  };
}

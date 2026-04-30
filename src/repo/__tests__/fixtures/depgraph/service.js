// service.js — imports a single named symbol from target.
import { createAppointment } from './target.js';

export function scheduleVisit(data) {
  return createAppointment(data);
}

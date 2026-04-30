// target.js — defines exports, imports nothing.
// Used as a leaf node in dependency graph tests.
export function createAppointment(data) { return data; }
export function listAppointments() { return []; }
export const VERSION = '1.0';
export default class AppointmentService {}

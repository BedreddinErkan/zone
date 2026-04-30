// barrel.js — re-exports from target.
// Verifies the graph doesn't crash on barrel files;
// re-export symbol tracking is a known limitation (not implemented).
export { createAppointment, listAppointments } from './target.js';

// controller.js — imports default + named (with alias) + namespace + side-effect.
import AppointmentService, { listAppointments, createAppointment as makeAppt } from './target.js';
import * as svc from './service.js';
import './barrel.js';

export function handleRequest(req) {
  const appts = listAppointments();
  return appts;
}

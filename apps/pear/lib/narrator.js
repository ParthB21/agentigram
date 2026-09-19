'use strict';

const { buildExplanationRequest, finalizeExplanation } = require('./prompt.js');

class Narrator {
  constructor(inference) {
    this.inference = inference;
    this.active = null;
  }

  start(events) {
    const request = buildExplanationRequest(events);
    if (request === null) return { started: null, superseded: null };
    const superseded = this.cancel('superseded');
    const id = this.inference.ask(request.history);
    this.active = { id, request, text: '' };
    return { started: { id, sourceSeqs: request.sourceSeqs }, superseded };
  }

  delta(id, text) {
    if (this.active?.id !== id) return null;
    this.active.text = `${this.active.text}${String(text)}`.slice(0, 4000);
    return { id, text: String(text) };
  }

  finish(id) {
    if (this.active?.id !== id) return null;
    const active = this.active;
    this.active = null;
    return {
      id,
      sourceSeqs: active.request.sourceSeqs,
      text: finalizeExplanation(active.text, active.request),
      fallback: active.text.trim().length === 0,
    };
  }

  fail(id) {
    if (this.active?.id !== id) return null;
    const active = this.active;
    this.active = null;
    return {
      id,
      sourceSeqs: active.request.sourceSeqs,
      text: active.request.fallback,
      fallback: true,
    };
  }

  cancel(reason = 'cancelled') {
    if (this.active === null) return null;
    const active = this.active;
    this.active = null;
    this.inference.cancel(active.id);
    return {
      id: active.id,
      sourceSeqs: active.request.sourceSeqs,
      text: `${active.request.fallback}\n[local explanation ${reason}]`,
      fallback: true,
    };
  }
}

module.exports = Narrator;

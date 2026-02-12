export const SHARED_EDITS_MESSAGE_ACTIONS = Object.freeze({
  RESYNC: "resync",
});

export const SHARED_EDITS_ERRORS = Object.freeze({
  BLANK_STATE_REJECTED: "blank_state_rejected",
  COMMIT_FAILED: "commit_failed",
  DISABLE_FAILED: "disable_failed",
  INVALID_UPDATE: "invalid_update",
  NEEDS_RECOVERY_TEXT: "needs_recovery_text",
  NOT_INITIALIZED: "not_initialized",
  POST_LENGTH_EXCEEDED: "post_length_exceeded",
  RECOVERY_FAILED: "recovery_failed",
  RECOVERY_NOT_NEEDED: "recovery_not_needed",
  RESET_FAILED: "reset_failed",
  STATE_DIVERGED: "state_diverged",
  STATE_RECOVERED: "state_recovered",
  STATE_RECOVERED_FROM_CLIENT: "state_recovered_from_client",
});

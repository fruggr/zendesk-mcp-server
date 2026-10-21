const SIGN_IN_REQUIRED = 'SignInRequiredError';

/**
 * What a background caller (the SLA alert poller) gets instead of a browser
 * sign-in: only a user action may open one, so the next tool call does.
 */
export const signInRequiredError = (): Error =>
  Object.assign(new Error('Not signed in to Zendesk: the next tool call starts the sign-in.'), {
    name: SIGN_IN_REQUIRED,
  });

export const isSignInRequired = (error: unknown): boolean =>
  error instanceof Error && error.name === SIGN_IN_REQUIRED;

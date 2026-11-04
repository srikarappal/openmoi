// Recognizes login walls, CAPTCHAs and checkpoints so automation stops and hands the page to you.

const CHALLENGE_PATH = /\/(login|signin|sign_in|i\/flow\/login|checkpoint|challenge|captcha)(\/|$|\?)/i
const CHALLENGE_TITLE = /captcha|verify you are human|unusual activity|are you a robot|log in|sign in/i
const CHALLENGE_ELEMENTS = "iframe[src*='captcha'], iframe[src*='challenge'], #challenge-form, [data-testid='loginButton']"

export function looks_like_challenge(page_url: string, title: string, root: ParentNode): boolean {
  let pathname = ""
  try {
    pathname = new URL(page_url).pathname
  } catch {
    pathname = ""
  }
  if (CHALLENGE_PATH.test(pathname) || CHALLENGE_TITLE.test(title)) return true
  if (root.querySelector(CHALLENGE_ELEMENTS)) return true
  return root.querySelector("input[type='password']") !== null
}

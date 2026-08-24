/**
 * Every capability module throws on a non-ok fetch response, but a bare
 * status code (e.g. "failed (400)") throws away exactly the detail that
 * would explain why — the API's own error body, which both a human
 * debugging this and Claude reasoning about a failed tool call need to
 * see. Truncated so a large/unexpected HTML error page can't blow up the
 * error message.
 */
export async function describeFailedResponse(response: Response): Promise<string> {
  const detail = await response.text().catch(() => "");
  return detail ? `${response.status}: ${detail.slice(0, 500)}` : String(response.status);
}

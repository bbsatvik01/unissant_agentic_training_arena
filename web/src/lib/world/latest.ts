/**
 * Request ordering for a user action that can be repeated before its answer arrives (choosing one run, then another,
 * to replay): each call to the returned function starts a request and gives back a check that stays true only while
 * no newer request has started. An answer whose check is false is ignored, so a slow earlier answer never replaces
 * a newer one.
 */
export function latestOnly(): () => () => boolean {
  let newest = 0;
  return () => {
    newest += 1;
    const mine = newest;
    return () => mine === newest;
  };
}

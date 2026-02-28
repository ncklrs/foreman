/**
 * Minimal glob/minimatch implementation for path matching.
 * Supports * (any non-separator chars) and ** (any path segment).
 */

export function minimatch(path: string, pattern: string): boolean {
  const regex = globToRegex(pattern);
  return regex.test(path);
}

function globToRegex(pattern: string): RegExp {
  let regex = "^";
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches any number of path segments
        if (pattern[i + 2] === "/") {
          regex += "(?:.*/)?";
          i += 3;
        } else {
          regex += ".*";
          i += 2;
        }
      } else {
        // * matches anything except /
        regex += "[^/]*";
        i++;
      }
    } else if (char === "?") {
      regex += "[^/]";
      i++;
    } else if (char === ".") {
      regex += "\\.";
      i++;
    } else if (char === "/") {
      regex += "/";
      i++;
    } else {
      regex += escapeRegex(char);
      i++;
    }
  }

  regex += "$";
  return new RegExp(regex);
}

function escapeRegex(char: string): string {
  return char.replace(/[[\]{}()+^$|\\]/g, "\\$&");
}

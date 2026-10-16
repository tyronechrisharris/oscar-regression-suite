#!/usr/bin/env bash
set -euo pipefail
umask 077

suite_dir=${OSCAR_REGRESSION_SUITE_DIR:-}
if [[ -z "$suite_dir" ]] || [[ ! -x "$suite_dir/scripts/run-regression.sh" ]]; then
  echo "Set OSCAR_REGRESSION_SUITE_DIR to a deployed oscar-regression-suite checkout." >&2
  exit 2
fi

exec "$suite_dir/scripts/run-regression.sh" "$@"

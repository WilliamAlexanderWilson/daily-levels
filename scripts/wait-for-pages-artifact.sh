#!/usr/bin/env bash
set -euo pipefail

# GitHub can report zero artifacts for a short time after upload-pages-artifact
# finishes. deploy-pages checks only once, so wait for the same run's artifact
# to become visible before asking Pages to publish it.
artifact_url="repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/artifacts?per_page=100"
for attempt in {1..12}; do
  if count=$(gh api "$artifact_url" --jq '[.artifacts[] | select(.name == "github-pages")] | length'); then
    if [ "$count" = 1 ]; then
      echo "Pages artifact is indexed (attempt $attempt)."
      exit 0
    fi
    if [ "$count" != 0 ]; then
      echo "::error::Expected one github-pages artifact for this run; found $count."
      exit 1
    fi
  fi
  if [ "$attempt" -lt 12 ]; then sleep 5; fi
done

echo "::error::Pages artifact did not become visible to the Actions API within one minute."
exit 1

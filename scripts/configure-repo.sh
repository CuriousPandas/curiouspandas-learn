#!/usr/bin/env bash
# Applies this repository's GitHub settings. Nothing else owns them, so this
# script is the source of truth: change a setting here and re-run it, never in
# the web UI, or a rebuild silently loses it. Safe to run repeatedly.
#
#   scripts/configure-repo.sh [owner/repo]     (needs gh, logged in as an admin)
set -euo pipefail
repo=${1:-CuriousPandas/curiouspandas-learn}
cd "$(dirname "$0")/.."

# Squash only, titled and described by the pull request, so each change lands
# on main as one commit whose message is the PR's write-up.
gh api -X PATCH "repos/$repo" \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY \
  -F delete_branch_on_merge=true > /dev/null

# main changes only through a pull request whose "verify" job passed: unit
# tests, astro check, the build, and the browser check in all three engines.
# No bypass actors, admins included: a direct push would deploy a build that
# no browser ever looked at. Zero approvals because there is one maintainer
# and GitHub does not let an author approve their own pull request.
id=$(gh api "repos/$repo/rulesets" --jq '.[] | select(.name == "main") | .id')
if [ -n "$id" ]; then
  gh api -X PUT "repos/$repo/rulesets/$id" --input .github/rulesets/main.json > /dev/null
else
  gh api -X POST "repos/$repo/rulesets" --input .github/rulesets/main.json > /dev/null
fi

# The Pages environment accepts deployments from main only, so even a workflow
# edited on a branch cannot publish that branch.
gh api -X PUT "repos/$repo/environments/github-pages" \
  --input - > /dev/null <<'JSON'
{ "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
JSON
if ! gh api "repos/$repo/environments/github-pages/deployment-branch-policies" --jq '.branch_policies[].name' | grep -qx main; then
  gh api -X POST "repos/$repo/environments/github-pages/deployment-branch-policies" -f name=main -f type=branch > /dev/null
fi

# Read back what GitHub actually holds, so a silently ignored field shows up.
echo "merges:    $(gh api "repos/$repo" --jq '"squash=\(.allow_squash_merge) merge=\(.allow_merge_commit) rebase=\(.allow_rebase_merge) delete_branch_on_merge=\(.delete_branch_on_merge)"')"
echo "ruleset:   $(gh api "repos/$repo/rules/branches/main" --jq '[.[].type] | join(", ")')"
echo "checks:    $(gh api "repos/$repo/rules/branches/main" --jq '[.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context] | join(", ")')"
echo "bypass:    $(gh api "repos/$repo/rulesets/$(gh api "repos/$repo/rulesets" --jq '.[] | select(.name == "main") | .id')" --jq '.bypass_actors | length') actor(s)"
echo "pages:     deploys from $(gh api "repos/$repo/environments/github-pages/deployment-branch-policies" --jq '[.branch_policies[].name] | join(", ")')"

#!/bin/sh
# pm-shim — shell_exec has no install authority (dependency trust audit 2026-09-16).
#
# shell.ts puts this directory FIRST on the child's PATH, and every package
# manager name in it (npm npx pnpm yarn bun bunx uvx corepack pip pip3 pipx uv
# poetry pipenv conda) is a symlink to this script. Whatever spelling the shell
# used to reach the name — `${P:-npm}`, `cat <<'EOF' | bash`, `node -e
# execSync(...)`, `python subprocess.run([...])`, `xargs`, a package.json
# script — resolves through PATH and lands here. Read-only verbs exec the real
# binary (next match on PATH); anything that mutates node_modules/lockfile,
# reconfigures registry/auth, or fetches-and-runs a registry package is refused
# with the operator hand-off. Unknown verbs are refused (allow-list).
#
# Only an absolute path (`/usr/bin/npm`, `node …/npm-cli.js`) bypasses PATH;
# the string gate in shell.ts covers those literals. POSIX sh: the sandbox
# image's /bin/sh is dash.
set -u

name=$(basename "$0")
self=$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")
shimdir=$(dirname "$self")
OPERATOR="a dependency or registry change is an operator decision (dependency trust audit 2026-09-16) — report the exact command for the operator instead"

refuse() {
  printf '[pm-shim] refused: %s — %s\n' "$1" "$OPERATOR" >&2
  exit 1
}

# Verb = first positional after flags and the values of value-taking flags.
verb=""
verb2=""
verb3=""
skip=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then
    skip=0
    continue
  fi
  case $a in
    --prefix | --registry | -C | --cwd | --dir | --loglevel | --userconfig | --cache | --scope | --tag | --otp | --filter | --project | --python) skip=1; continue ;;
    -w | --workspace) [ "$name" = npm ] && skip=1; continue ;; # value for npm only (pnpm/bun: boolean, qa R4 W-5)
    -*) continue ;;
  esac
  if [ -z "$verb" ]; then verb=$a
  elif [ -z "$verb2" ]; then verb2=$a
  elif [ -z "$verb3" ]; then verb3=$a
  fi
done

case $name in
  uvx | bunx | corepack)
    refuse "\`$name\` fetches and runs a registry package"
    ;;
  npm | pnpm | yarn | bun)
    case $verb in
      "")
        [ "$name" = yarn ] && refuse "bare \`yarn\` installs"
        ;;
      run | run-script | ls | list | ll | la | why | explain | outdated | view | info | show | v \
        | help | help-search | get | ping | root | prefix | bin | test | t | tst | start | stop | restart \
        | query | search | s | se | find | docs | home | repo | bugs | doctor | fund | diff | whoami \
        | sbom | completion | build | licenses | check | env | dedupe-check) ;;
      version)
        [ -n "$verb2" ] && refuse "\`$name version $verb2\` rewrites package.json"
        ;;
      audit)
        [ "$verb2" = fix ] && refuse "\`$name audit fix\` mutates node_modules/lockfile"
        ;;
      config | c)
        case $verb2 in get | list | ls) ;; *) refuse "\`$name config $verb2\` changes the registry/auth setup" ;; esac
        ;;
      pkg)
        [ "$verb2" = get ] || refuse "\`$name pkg $verb2\` rewrites package.json"
        ;;
      install-scripts)
        [ "$verb2" = ls ] || [ "$verb2" = list ] || refuse "\`$name install-scripts $verb2\` rewrites package.json"
        ;;
      workspace)
        case $verb3 in run | list | ls | why | info) ;; *) refuse "\`yarn workspace $verb2 $verb3\` is not a read" ;; esac
        ;;
      workspaces)
        [ "$verb2" = list ] || refuse "\`yarn workspaces $verb2\` is not a read"
        ;;
      exec | x | dlx)
        refuse "\`$name $verb\` fetches and runs a registry package"
        ;;
      *)
        refuse "\`$name $verb\` mutates node_modules/lockfile or is not on the read-only allow-list"
        ;;
    esac
    ;;
  npx)
    for a in "$@"; do
      case $a in
        -y | --yes | -p | --package | --package=* | -c | --call | --call=*) refuse "\`npx $a\` fetches a registry package" ;;
        --) break ;;
      esac
    done
    if [ -n "$verb" ]; then
      case $verb in
        @*/*)
          case ${verb#@} in *@*) refuse "\`npx $verb\` carries a version spec — npm resolves that against the registry, not the local bin" ;; esac
          ;;
        *@*) refuse "\`npx $verb\` carries a version spec — npm resolves that against the registry, not the local bin" ;;
      esac
      found=""
      case $verb in
        @*)
          d=$PWD
          while :; do
            [ -d "$d/node_modules/$verb" ] && found=1 && break
            [ "$d" = / ] && break
            d=$(dirname "$d")
          done
          ;;
        */node_modules/.bin/* | node_modules/.bin/*)
          [ -e "$verb" ] && found=1
          ;;
        */*)
          ;;
        *)
          d=$PWD
          while :; do
            [ -e "$d/node_modules/.bin/$verb" ] && found=1 && break
            [ "$d" = / ] && break
            d=$(dirname "$d")
          done
          ;;
      esac
      [ -n "$found" ] || refuse "\`npx $verb\` is not installed under $PWD/node_modules (or any parent) — npm would fetch it from the registry and run it"
    fi
    ;;
  pip | pip3)
    case $verb in
      "" | list | show | freeze | check | debug | help | inspect | index) ;;
      config) case $verb2 in list | get | debug) ;; *) refuse "\`pip config $verb2\` changes the index/auth setup" ;; esac ;;
      cache) case $verb2 in dir | info | list) ;; *) refuse "\`pip cache $verb2\` is not a read" ;; esac ;;
      *) refuse "\`$name $verb\` installs Python packages or is not on the read-only allow-list" ;;
    esac
    ;;
  pipx)
    case $verb in
      "" | list | environment) ;;
      *) refuse "\`pipx $verb\` installs or runs Python packages" ;;
    esac
    ;;
  uv)
    case $verb in
      "" | tree | version | help) ;;
      pip) case $verb2 in list | show | freeze | check | tree) ;; *) refuse "\`uv pip $verb2\` installs Python packages" ;; esac ;;
      tool) case $verb2 in list | dir) ;; *) refuse "\`uv tool $verb2\` installs or runs Python packages" ;; esac ;;
      python) case $verb2 in list | find | dir) ;; *) refuse "\`uv python $verb2\` downloads interpreters" ;; esac ;;
      cache) [ "$verb2" = dir ] || refuse "\`uv cache $verb2\` is not a read" ;;
      *) refuse "\`uv $verb\` installs or runs Python packages" ;;
    esac
    ;;
  poetry)
    case $verb in
      "" | show | check | version | about | help | list) ;;
      env) case $verb2 in info | list) ;; *) refuse "\`poetry env $verb2\` is not a read" ;; esac ;;
      config) [ -z "$verb2" ] || refuse "\`poetry config $verb2\` changes the repository/auth setup" ;;
      *) refuse "\`poetry $verb\` installs Python packages" ;;
    esac
    ;;
  pipenv)
    case $verb in
      "" | graph | check | verify | requirements) ;;
      *) refuse "\`pipenv $verb\` installs or runs Python packages" ;;
    esac
    ;;
  conda)
    case $verb in
      "" | list | info | search | compare | doctor) ;;
      env) case $verb2 in list | export) ;; *) refuse "\`conda env $verb2\` mutates environments" ;; esac ;;
      config) [ -z "$verb2" ] || refuse "\`conda config $verb2\` changes the channel setup" ;;
      *) refuse "\`conda $verb\` installs packages" ;;
    esac
    ;;
  *)
    refuse "\`$name\` is not a package manager this shim knows"
    ;;
esac

# Allowed: exec the real binary = first PATH match outside this directory.
real=""
oldifs=$IFS
IFS=:
for d in $PATH; do
  [ -z "$d" ] && d=.
  [ "$d" = "$shimdir" ] && continue
  if [ -f "$d/$name" ] && [ -x "$d/$name" ]; then
    case $(readlink -f "$d/$name" 2>/dev/null) in "$shimdir"/*) continue ;; esac
    real="$d/$name"
    break
  fi
done
IFS=$oldifs
if [ -z "$real" ]; then
  printf '%s: command not found\n' "$name" >&2
  exit 127
fi
exec "$real" "$@"

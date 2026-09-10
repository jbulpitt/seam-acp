#!/bin/sh
case "${1:-}" in
  --version)
    printf '%s\n' 'agy-shell-test 1.0'
    ;;
  models)
    printf '%s\n' 'shell-model Shell Model'
    ;;
  *)
    exit 2
    ;;
esac

#!/bin/bash
set -u
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
passed=0 failed=0

check() {
    local name=$1 input=$2 expected_status=$3 expected_summary=$4 expected_stderr=$5 expected_lines=$6
    shift 6
    printf '%s' "$input" | ./bin/logscope "$@" >"$scratch/out" 2>"$scratch/err"
    local actual_status=$? okay=1
    [[ $actual_status == "$expected_status" ]] || okay=0
    grep -Fxq "$expected_summary" "$scratch/out" || okay=0
    [[ $(wc -l <"$scratch/out") -eq $expected_lines ]] || okay=0
    if [[ $expected_stderr == EMPTY ]]; then
        [[ ! -s "$scratch/err" ]] || okay=0
    else
        grep -Fq "$expected_stderr" "$scratch/err" || okay=0
    fi
    if (( okay )); then
        printf 'PASS %s\n' "$name"
        ((passed+=1))
    else
        printf 'FAIL %s (status %s, expected %s)\n' "$name" "$actual_status" "$expected_status" >&2
        cat "$scratch/out" "$scratch/err" >&2
        ((failed+=1))
    fi
}

summary() {
    printf '{"type":"summary","requests":%s,"errors":%s,"slow":%s,"p95Ms":%s,"maxMs":%s}' "$@"
}

check 'empty stream' '' 0 "$(summary 0 0 0 0 0)" EMPTY 1
check 'blank lines and comments' $'\n   # ignored\n\t\n' 0 "$(summary 0 0 0 0 0)" EMPTY 1
check 'one healthy request' $'GET / 200 42\n' 0 "$(summary 1 0 0 42 42)" EMPTY 2
check 'inclusive slow threshold' $'GET /a 200 999\nGET /b 200 1000\nGET /c 200 1001\n' 0 "$(summary 3 0 2 1001 1001)" 'ALERT slow' 4
check 'only 5xx counts as server error' $'GET /a 499 1\nGET /b 500 1\nGET /c 599 1\n' 0 "$(summary 3 2 0 1 1)" 'ALERT server-error' 4

input=''
for ((i=20; i>=1; i--)); do input+="GET /sorted 200 $i"$'\n'; done
check 'p95 nearest rank for 20 reverse-sorted values' "$input" 0 "$(summary 20 0 0 19 20)" EMPTY 21
input+=$'GET /sorted 200 21\n'
check 'p95 rounds up for 21 values' "$input" 0 "$(summary 21 0 0 20 21)" EMPTY 22
check 'zeros and repeated latencies' $'GET /a 200 0\nGET /a 200 0\nGET /a 200 7\nGET /a 200 7\n' 0 "$(summary 4 0 0 7 7)" EMPTY 5
check 'custom threshold with leading zeros' $'GET /a 200 249\nGET /b 200 250\n' 0 "$(summary 2 0 1 250 250)" 'ALERT slow' 3 --slow-ms 000250
check 'zero threshold' $'GET /a 200 0\n' 0 "$(summary 1 0 1 0 0)" 'ALERT slow' 2 --slow-ms 0

invalid=$'GET /missing 200\nGET /extra 200 1 extra\nGET /negative 200 -1\nGET /decimal 200 1.5\nGET /text 200 nope\nGET /huge 200 600001\nGET /status 99 1\nGET /status 600 1\nGET relative 200 1\nGET /good 200 8\n'
check 'reject malformed records but retain valid data' "$invalid" 2 "$(summary 1 0 0 8 8)" 'INVALID line=1' 2
check 'maximum accepted latency' $'GET /max 200 600000\n' 0 "$(summary 1 0 1 600000 600000)" 'ALERT slow' 2
check 'errors fail CI when requested' $'POST /checkout 503 5\n' 3 "$(summary 1 1 0 5 5)" 'ALERT server-error' 2 --fail-on-errors
check 'invalid input takes precedence over CI failure' $'POST /checkout 503 5\nbroken\n' 2 "$(summary 1 1 0 5 5)" 'INVALID line=2' 2 --fail-on-errors
check 'version' '' 0 'logscope 0.1.0' EMPTY 1 --version

for flag in --unknown --slow-ms; do
    ./bin/logscope "$flag" </dev/null >"$scratch/out" 2>"$scratch/err"
    rc=$?
    if [[ $rc == 2 && ! -s "$scratch/out" && -s "$scratch/err" ]]; then
        printf 'PASS invalid arguments %s\n' "$flag"; ((passed+=1))
    else
        printf 'FAIL invalid arguments %s (status %s)\n' "$flag" "$rc" >&2; ((failed+=1))
    fi
done

printf '\n%d passed, %d failed\n' "$passed" "$failed"
(( failed == 0 ))

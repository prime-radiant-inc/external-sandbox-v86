CC ?= cc
CFLAGS ?= -O2 -std=c11 -Wall -Wextra -Werror
LDFLAGS ?=

all: v86-agent

v86-agent: agent.c
	$(CC) $(CFLAGS) agent.c -o $@ $(LDFLAGS)

clean:
	rm -f v86-agent

test: v86-agent
	node --test test.mjs

.PHONY: all clean test

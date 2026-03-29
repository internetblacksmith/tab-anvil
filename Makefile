.DEFAULT_GOAL := menu

# Colors
CYAN    := \033[36m
GREEN   := \033[32m
YELLOW  := \033[33m
DIM     := \033[2m
BOLD    := \033[1m
RESET   := \033[0m

menu:
	@printf "\n"
	@printf "$(BOLD)$(CYAN)╔══════════════════════════════════════════════════════════════╗$(RESET)\n"
	@printf "$(BOLD)$(CYAN)║                TabAnvil - Command Menu                      ║$(RESET)\n"
	@printf "$(BOLD)$(CYAN)╚══════════════════════════════════════════════════════════════╝$(RESET)\n"
	@printf "\n"
	@printf "  $(BOLD)$(GREEN)=== Development ===$(RESET)\n"
	@printf "   $(YELLOW)1)$(RESET)  make lint              $(DIM)Lint JS files$(RESET)\n"
	@printf "\n"
	@printf "  $(BOLD)$(GREEN)=== Build & Deploy ===$(RESET)\n"
	@printf "   $(YELLOW)2)$(RESET)  make package           $(DIM)Package as .xpi$(RESET)\n"
	@printf "   $(YELLOW)3)$(RESET)  make clean             $(DIM)Remove build artifacts$(RESET)\n"
	@printf "\n"
	@read -p "  Enter choice: " choice; \
	case $$choice in \
		1) $(MAKE) lint ;; \
		2) $(MAKE) package ;; \
		3) $(MAKE) clean ;; \
		*) echo "Invalid choice" ;; \
	esac

lint:
	@printf "$(CYAN)Linting JS files...$(RESET)\n"
	@find . -name '*.js' -not -path './dist/*' -exec js -c {} \; 2>/dev/null || \
		find . -name '*.js' -not -path './dist/*' -print0 | xargs -0 -I{} sh -c 'node --check "{}" && printf "  $(GREEN)OK$(RESET) {}\n" || printf "  $(YELLOW)WARN$(RESET) {}\n"'

package:
	@printf "$(CYAN)Packaging TabAnvil...$(RESET)\n"
	@mkdir -p dist
	@cd . && zip -r dist/tab-anvil.xpi manifest.json background.js dashboard.html dashboard.js dashboard.css icons/ -x '*.DS_Store' -x 'dist/*'
	@printf "$(GREEN)Packaged:$(RESET) dist/tab-anvil.xpi\n"

clean:
	@rm -rf dist
	@printf "$(GREEN)Cleaned build artifacts$(RESET)\n"

help:
	@printf "\n"
	@printf "$(BOLD)Available commands:$(RESET)\n"
	@printf "\n"
	@printf "  $(CYAN)make lint$(RESET)              Lint JS files\n"
	@printf "  $(CYAN)make package$(RESET)           Package as .xpi for distribution\n"
	@printf "  $(CYAN)make clean$(RESET)             Remove build artifacts\n"
	@printf "\n"

list: help

.PHONY: menu lint package clean help list

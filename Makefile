NAME    := sw-blocker
VERSION := $(shell jq -r .version manifest.json)
ZIP     := $(NAME)-$(VERSION).zip

SOURCES := manifest.json background.js inject.js \
           popup.html popup.js popup.css \
           icons/icon16.png icons/icon48.png icons/icon128.png

.PHONY: zip clean

zip: $(ZIP)

$(ZIP): $(SOURCES)
	@rm -f $@
	zip -r $@ $^
	@echo "Created $@ ($$(du -h $@ | cut -f1))"

clean:
	rm -f $(NAME)-*.zip

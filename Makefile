DRIVE_PATH := gdrive:DAT Tapes/DAT Tapes WAV Files/Hannans
R2_BUCKET  := r2:hannan-audio
# gdrive: is now the OWNER account (renedebos@hotmail, 5 TB). Owned content is
# reached by path with no flag; --drive-shared-with-me would EXCLUDE it. Left
# empty (not removed) so it's easy to restore if the auth ever changes back.
DRIVE_FLAGS :=
R2_FLAGS    := --s3-no-check-bucket

.PHONY: refresh diff status upload edit build sync-titles

edit:
	python3 scripts/edit_metadata.py

tcap:
	python3 scripts/tcap_ui.py

build:
	python3 scripts/build.py

# Reconcile the Drive source split filenames with the catalog titles. Dry run
# by default; APPLY=1 actually renames on Drive. Deliberately NOT part of
# `build` — build stays offline and byte-reproducible for CI, and only warns.
sync-titles:
	python3 scripts/sync_source_titles.py $(if $(APPLY),--apply,) $(if $(ONLY),--only $(ONLY),)

refresh:
	rclone ls "$(DRIVE_PATH)" $(DRIVE_FLAGS) | awk -F'/' '{print $$NF}' | sort > drive_names.txt
	rclone ls $(R2_BUCKET) $(R2_FLAGS) | awk -F'/' '{print $$NF}' | sort > r2_names.txt
	@echo "Updated drive_names.txt and r2_names.txt"

diff: drive_names.txt r2_names.txt
	@echo "Files in Drive not yet in R2:"
	@comm -23 drive_names.txt r2_names.txt

status: drive_names.txt r2_names.txt
	@echo "Drive: $$(wc -l < drive_names.txt) files"
	@echo "R2:    $$(wc -l < r2_names.txt) files"
	@echo "Missing from R2: $$(comm -23 drive_names.txt r2_names.txt | wc -l) files"

upload:
ifndef FILE
	$(error Usage: make upload FILE="filename.wav")
endif
	rclone copy "$(DRIVE_PATH)/$(FILE)" $(R2_BUCKET) --progress $(DRIVE_FLAGS) $(R2_FLAGS)

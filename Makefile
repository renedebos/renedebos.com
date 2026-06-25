DRIVE_PATH := gdrive:DAT Tapes/DAT Tapes WAV Files/Hannans
R2_BUCKET  := r2:hannan-audio
DRIVE_FLAGS := --drive-shared-with-me
R2_FLAGS    := --s3-no-check-bucket

.PHONY: refresh diff status upload edit build

edit:
	python3 scripts/edit_metadata.py

build:
	python3 scripts/build.py

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

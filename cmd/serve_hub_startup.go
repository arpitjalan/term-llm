package cmd

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/samsaffron/term-llm/internal/appdata"
	"github.com/samsaffron/term-llm/internal/config"
)

func validateHubPersonalBotOptions(personalBot, containDiscovery bool, image, binary string) error {
	if personalBot && !containDiscovery {
		return fmt.Errorf("--personal-bot requires contain discovery; remove --contain=false")
	}
	if !personalBot && (image != "" || binary != "") {
		return fmt.Errorf("--personal-bot-image and --personal-bot-binary require --personal-bot")
	}
	return nil
}

func hubPersonalBotStartupSummary(image, binary string) (string, error) {
	configDir, err := config.GetConfigDir()
	if err != nil {
		return "", fmt.Errorf("resolve Personal Bot config directory: %w", err)
	}
	configDir, err = filepath.Abs(configDir)
	if err != nil {
		return "", fmt.Errorf("resolve Personal Bot config directory: %w", err)
	}
	dataDir, err := appdata.GetDataDir()
	if err != nil {
		return "", fmt.Errorf("resolve Hub data directory: %w", err)
	}
	dataDir, err = filepath.Abs(dataDir)
	if err != nil {
		return "", fmt.Errorf("resolve Hub data directory: %w", err)
	}
	runtimeSource := "image: " + image
	if image == "" {
		runtimeSource = "binary: " + binary
		if binary == "" {
			binary, err = os.Executable()
			if err != nil {
				return "", fmt.Errorf("resolve Personal Bot runtime executable: %w", err)
			}
			runtimeSource = "current executable: " + binary
		}
	}
	return fmt.Sprintf("  config directory: %s\n  assistant store: %s\n  data directory: %s\n  assistant runtime %s\n",
		configDir, filepath.Join(configDir, "containers"), dataDir, runtimeSource), nil
}

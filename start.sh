#!/bin/bash

# Exit immediately if a command exits with a non-zero status.
set -e

echo "Installing dependencies..."
npm install

echo "Starting ore-bot..."
npm start

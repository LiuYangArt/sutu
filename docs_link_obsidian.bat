@echo off
chcp 65001
echo obsidian_vault_path

set /P vault_path=version: 
PAUSE


mklink /j "%vault_path%\sutu_docs" ".\docs"



pause
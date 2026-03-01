# Lightning Arena Mod - CMake Build
# Add to SuperTuxKart's main CMakeLists.txt

# Additional source files for Lightning Arena
set(LIGHTNING_ARENA_SOURCES
    modes/three_strikes_battle.cpp
    modes/three_strikes_battle.hpp
)

# Add to STK sources
list(APPEND STK_SOURCES ${LIGHTNING_ARENA_SOURCES})

# Optional: Add compile definitions
add_definitions(-DLIGHTNING_ARENA_ENABLED=1)

# Copy assets to build directory
file(COPY ${CMAKE_CURRENT_SOURCE_DIR}/assets/
     DESTINATION ${CMAKE_BINARY_DIR}/data/gui/icons/)

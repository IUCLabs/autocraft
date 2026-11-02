import argparse
import importlib

# Each module registers its own subcommands with register(subparsers).
MODULES = ["craft_auto.mirror", "craft_auto.whitelist", "craft_auto.dash"]


def main() -> None:
    parser = argparse.ArgumentParser(prog="craft-auto")
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name in MODULES:
        try:
            importlib.import_module(name).register(sub)
        except ModuleNotFoundError as e:
            if e.name != name:
                raise
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()

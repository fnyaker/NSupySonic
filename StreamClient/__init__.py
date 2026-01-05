"""
StreamClient - Simple Deezer client for search, download and user data.

Usage:
    from StreamClient import StreamClient

    async def main():
        client = StreamClient(arl="YOUR_ARL")
        await client.login()

        # Search
        results = await client.search("Daft Punk", type="artist")

        # Download
        await client.download_album("123456")

        # User data
        favorites = await client.get_user_tracks("user_id")
"""

from .client import StreamClient

__all__ = ["StreamClient"]

